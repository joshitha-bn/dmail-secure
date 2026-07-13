import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// Helper: Normalize subject to reconstruct conversation threads dynamically
const normalizeSubject = (s) =>
  (s || "(No subject)").replace(/^((Re|Fwd):\s*)+/i, "").trim();

// Helper: Upload a buffer to IPFS (reusing Pinata proxy or local Kubo node)
async function uploadAttachmentToIPFS(buffer, filename, mimetype) {
  const pinataJwt = process.env.PINATA_JWT || "";
  
  // 1. Try Pinata first if JWT is present
  if (pinataJwt) {
    try {
      console.log(`[IPFS Sync] Attempting Pinata upload for attachment: ${filename}`);
      const blob = new Blob([buffer], { type: mimetype || "application/octet-stream" });
      const formData = new FormData();
      formData.append("file", blob, filename || `file_${Date.now()}`);
      formData.append("pinataMetadata", JSON.stringify({ name: filename || `file_${Date.now()}` }));
      formData.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

      const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
        method: "POST",
        headers: { "Authorization": `Bearer ${pinataJwt}` },
        body: formData,
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`[IPFS Sync] Attachment pinned to Pinata. CID: ${result.IpfsHash}`);
        return result.IpfsHash;
      }
      console.warn(`[IPFS Sync] Pinata upload returned status ${response.status}: ${response.statusText}`);
    } catch (err) {
      console.warn("[IPFS Sync] Pinata upload error, trying local Kubo fallback:", err.message);
    }
  }

  // 2. Fallback to local Kubo node on port 5001
  try {
    console.log(`[IPFS Sync] Attempting local Kubo upload for attachment: ${filename}`);
    const blob = new Blob([buffer], { type: mimetype || "application/octet-stream" });
    const formData = new FormData();
    formData.append("file", blob, filename || `file_${Date.now()}`);

    const response = await fetch("http://127.0.0.1:5001/api/v0/add?pin=true", {
      method: "POST",
      body: formData,
    });

    if (response.ok) {
      const text = await response.text();
      // Kubo API returns JSON lines, the last line has the hash
      const result = JSON.parse(text.trim().split("\n").pop());
      console.log(`[IPFS Sync] Attachment stored on local Kubo. CID: ${result.Hash}`);
      return result.Hash;
    }
    throw new Error(`Kubo API returned status ${response.status}: ${response.statusText}`);
  } catch (err) {
    console.error("[IPFS Sync] Local Kubo upload failed:", err.message);
    throw new Error(`IPFS Attachment storage failed: ${err.message}`);
  }
}

// Start the IMAP Synchronization worker
export async function startIMAPSync(gun) {
  console.log("⚙️ [IMAP Sync] Starting synchronization service...");

  let reconnectDelay = 5000; // Exponential reconnect backoff starting at 5s
  let client = null;
  let isConnecting = false;
  let initialConnected = false;
  let lastKnownUid = null; // Track mailbox UIDs dynamically

  // Resolves IMAP config dynamically from .env
  async function resolveIMAPConfig() {
    let host = process.env.IMAP_HOST;
    let port = parseInt(process.env.IMAP_PORT || "993");
    let secure = process.env.IMAP_SECURE !== "false";
    let user = process.env.IMAP_USER || process.env.SMTP_EMAIL || process.env.SMTP_USER;
    let pass = process.env.IMAP_PASSWORD || process.env.IMAP_PASS || process.env.SMTP_PASSWORD || process.env.SMTP_PASS;

    if (!host || !user || !pass || pass === "your_gmail_app_password_here") {
      throw new Error("❌ [IMAP Sync] Configuration error: IMAP_HOST, IMAP_USER, and IMAP_PASSWORD must be configured in backend/.env.");
    }

    return { host, port, secure, auth: { user, pass } };
  }

  // Find recipient routing
  async function getDefaultUser() {
    return new Promise((resolve) => {
      let resolved = false;
      // Map over all registered users in GunDB
      gun.get("securemail_users").map().once((data, email) => {
        if (resolved) return;
        if (email && email.includes("@")) {
          resolved = true;
          resolve(email);
        }
      });
      
      // Fallback if no users have registered on this relay yet
      setTimeout(() => {
        if (!resolved) {
          resolve("admin@securemail.com");
        }
      }, 1500);
    });
  }

  // Helper to query GunDB once with a timeout to avoid hangs
  function gunGetOnce(nodeName, key, timeoutMs = 1500) {
    return new Promise(resolve => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, timeoutMs);

      gun.get(nodeName).get(key).once(data => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(data);
        }
      });
    });
  }

  // Connects securely, verifies connection on startup, and initializes sync and idle listeners
  async function connect() {
    if (isConnecting) return;
    isConnecting = true;

    try {
      const config = await resolveIMAPConfig();
      console.log(`⚙️ [IMAP Sync] Verifying IMAP connection to ${config.host} using account ${config.auth.user}...`);
      
      client = new ImapFlow({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.auth,
        logger: false
      });

      // Register error and close listeners early to prevent unhandled Socket timeout crashes
      client.on("close", () => {
        console.warn("⚠️ [IMAP Sync] Connection closed. Reconnecting...");
        scheduleReconnect();
      });

      client.on("error", (err) => {
        console.error("❌ [IMAP Sync] Connection error:", err.message);
        scheduleReconnect();
      });

      await client.connect();
      console.log(`✅ [IMAP Sync] IMAP Connection verified successfully. Syncing mailbox: ${config.auth.user}`);
      reconnectDelay = 5000; // Reset reconnect delay on success
      initialConnected = true;

      // Perform initial catch-up synchronization
      await syncMailbox();

      // Listen for incoming new messages in real-time
      client.on("exists", async (data) => {
        console.log(`🔔 [IMAP Sync] Server announced EXISTS event: ${data.count} messages currently in mailbox.`);
        try {
          await syncMailbox();
        } catch (syncErr) {
          console.error("❌ [IMAP Sync] Real-time sync error:", syncErr.message);
        }
      });

      // Keep IDLE state alive continuously
      while (client) {
        console.log("⏱️ [IMAP Sync] Entering IDLE mode (listening for new emails)...");
        await client.idle();
      }

    } catch (err) {
      console.error("❌ [IMAP Sync] IMAP connection failed:", err.message);
      if (!initialConnected && process.env.NODE_ENV === "production") {
        console.error("❌ [IMAP Sync] Critical IMAP connection error on startup. Exiting process.");
        process.exit(1);
      } else {
        console.warn("⚠️ [IMAP Sync] IMAP Sync failed to initialize on startup. Retrying reconnection...");
        scheduleReconnect();
      }
    } finally {
      isConnecting = false;
    }
  }

  function scheduleReconnect() {
    if (client) {
      try {
        client.close();
      } catch {}
      client = null;
    }
    console.log(`🔌 [IMAP Sync] Retrying connection in ${reconnectDelay / 1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000); // Exponential backoff capped at 60s
  }

  // Synchronizes inbox and pulls newly received emails
  async function syncMailbox() {
    if (!client) return;
    
    console.log("🔍 [IMAP Sync] Selecting and locking INBOX mailbox...");
    let lock = await client.getMailboxLock("INBOX");
    try {
      const currentCount = client.mailbox ? client.mailbox.exists : 0;
      console.log(`🔍 [IMAP Sync] Current mailbox exists count: ${currentCount}, Last known UID: ${lastKnownUid}`);
      
      if (currentCount === 0) {
        console.log("🔍 [IMAP Sync] Mailbox is empty. Skipping sync.");
        lastKnownUid = 0;
        return;
      }

      let fetchRange = "1:*";
      let fetchOptions = {};

      if (lastKnownUid !== null && lastKnownUid > 0) {
        fetchRange = `${lastKnownUid + 1}:*`;
        fetchOptions = { uid: true };
        console.log(`🔍 [IMAP Sync] Optimizing sync: fetching only messages with UID > ${lastKnownUid}`);
      } else if (currentCount > 50) {
        fetchRange = `${currentCount - 49}:${currentCount}`;
        console.log(`🔍 [IMAP Sync] Initial sync optimization: fetching latest 50 messages (range: ${fetchRange})`);
      } else {
        console.log(`🔍 [IMAP Sync] Fetching all messages (range: ${fetchRange})`);
      }
      
      console.log(`🔍 [IMAP Sync] Fetching message list from INBOX...`);
      const messagesGenerator = await client.fetch(fetchRange, { envelope: true, uid: true, source: false }, fetchOptions);
      const fetchedMessages = [];
      for await (const msg of messagesGenerator) {
        fetchedMessages.push(msg);
      }

      console.log(`🔍 [IMAP Sync] Fetched metadata for ${fetchedMessages.length} messages. Processing new mails...`);
      
      let maxUid = lastKnownUid || 0;
      let index = 0;
      for (const msg of fetchedMessages) {
        index++;
        if (msg.uid && msg.uid > maxUid) {
          maxUid = msg.uid;
        }

        console.log(`🔍 [IMAP Sync] [${index}] Processing msg UID: ${msg.uid}`);
        const messageId = msg.envelope?.messageId;
        console.log(`🔍 [IMAP Sync] [${index}] Message-ID: ${messageId}`);
        if (!messageId) {
          console.log(`🔍 [IMAP Sync] [${index}] No Message-ID, skipping...`);
          continue;
        }

        // Check if message has been processed to prevent duplicates (using 400ms timeout)
        console.log(`🔍 [IMAP Sync] [${index}] Checking processed status in GunDB...`);
        const processed = await gunGetOnce("securemail_processed_message_ids", messageId, 400);
        console.log(`🔍 [IMAP Sync] [${index}] Processed status result: ${processed}`);
        if (processed) {
          console.log(`🔍 [IMAP Sync] [${index}] Message already processed, skipping.`);
          continue;
        }

        console.log(`📥 [IMAP Sync] Found new unprocessed email. Message-ID: ${messageId}`);
        console.log(`📥 [IMAP Sync] Downloading raw MIME message for UID: ${msg.uid}...`);

        // Fetch full raw MIME source for parsing by UID
        console.log(`📥 [IMAP Sync] Initiating download via client.download...`);
        const rawMsg = await client.download(msg.uid, undefined, { uid: true });
        console.log(`📥 [IMAP Sync] Download resolved. Stream obtained. Size: ${msg.size || "unknown"} bytes`);
        if (!rawMsg || !rawMsg.content) {
          console.warn(`⚠️ [IMAP Sync] Failed to download content for UID ${msg.uid}`);
          continue;
        }

        await processIncomingEmail(rawMsg.content, messageId);
      }
      
      if (maxUid > 0) {
        lastKnownUid = maxUid;
        console.log(`🔍 [IMAP Sync] Synchronized up to UID: ${lastKnownUid}`);
      }
      
    } finally {
      lock.release();
    }
  }

  // Parses raw email, handles attachments, threads, and stores in GunDB
  async function processIncomingEmail(rawContent, messageId) {
    try {
      console.log("⚙️ [IMAP Sync] Starting MailParser MIME parsing...");
      const parsed = await simpleParser(rawContent);
      console.log("⚙️ [IMAP Sync] MIME parsing complete.");

      const senderObj = parsed.from?.value?.[0] || {};
      const senderAddr = senderObj.address || "unknown@external.com";
      const subject = parsed.subject || "(No Subject)";
      const bodyText = parsed.text || "";
      const bodyHtml = parsed.html || "";
      const emailDate = parsed.date || new Date();

      const ccList = parsed.cc ? (Array.isArray(parsed.cc.value) ? parsed.cc.value.map(c => c.address) : [parsed.cc.value?.address].filter(Boolean)) : [];
      const bccList = parsed.bcc ? (Array.isArray(parsed.bcc.value) ? parsed.bcc.value.map(b => b.address) : [parsed.bcc.value?.address].filter(Boolean)) : [];

      console.log(`📧 [IMAP Sync] Parsed email metadata:`);
      console.log(`   - Subject: "${subject}"`);
      console.log(`   - From: ${senderAddr}`);
      console.log(`   - Message-ID: ${messageId}`);
      console.log(`   - In-Reply-To: ${parsed.inReplyTo}`);
      console.log(`   - References: ${JSON.stringify(parsed.references)}`);

      // 1. Process attachments and upload to IPFS
      const attachmentsList = [];
      if (parsed.attachments && parsed.attachments.length > 0) {
        for (const att of parsed.attachments) {
          try {
            console.log(`📎 [IMAP Sync] Processing attachment: ${att.filename} (${att.size} bytes)`);
            const cid = await uploadAttachmentToIPFS(att.content, att.filename, att.contentType);
            attachmentsList.push({
              name: att.filename || "Attachment",
              type: "ipfs",
              cid: cid,
              size: att.size || att.content.length
            });
          } catch (attErr) {
            console.error(`❌ [IMAP Sync] Failed to upload attachment ${att.filename} to IPFS:`, attErr.message);
          }
        }
      }

      // 2. Reconstruct Conversation Threading
      let threadId = null;
      let userEmail = null;
      
      const inReplyTo = parsed.inReplyTo ? parsed.inReplyTo.trim() : null;
      let parentMapping = null;

      console.log("🔍 [IMAP Sync] Performing thread lookup in GunDB...");

      // Check In-Reply-To
      if (inReplyTo) {
        console.log(`🔍 [IMAP Sync] Checking In-Reply-To index for Message-ID: ${inReplyTo}`);
        parentMapping = await gunGetOnce("securemail_message_ids", inReplyTo, 400);
      }

      // Check References (fallback) in parallel
      if (!parentMapping && parsed.references) {
        const refs = (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
          .map(r => r ? r.trim() : null)
          .filter(Boolean);
        if (refs.length > 0) {
          console.log(`🔍 [IMAP Sync] Checking References index in parallel for IDs: ${JSON.stringify(refs)}`);
          const lookupPromises = refs.map(ref => gunGetOnce("securemail_message_ids", ref, 400));
          const mappings = await Promise.all(lookupPromises);
          parentMapping = mappings.find(m => m !== null);
        }
      }

      // Match found
      if (parentMapping) {
        threadId = parentMapping.threadId;
        userEmail = parentMapping.userEmail;
        console.log(`🧵 [IMAP Sync] Thread match found via Message-ID/References! threadId: ${threadId}, userEmail: ${userEmail}`);
      } else {
        // Fallback: match by normalized subject
        const normSubject = normalizeSubject(subject);
        console.log(`🔍 [IMAP Sync] Thread lookup failed on Message-ID/References. Trying subject fallback for: "${normSubject}"`);
        const subjectMapping = await gunGetOnce("securemail_subject_threads", normSubject, 400);

        if (subjectMapping) {
          threadId = subjectMapping.threadId;
          userEmail = subjectMapping.userEmail;
          console.log(`🧵 [IMAP Sync] Subject thread match found! threadId: ${threadId}, userEmail: ${userEmail}`);
        } else {
          // New conversation
          threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          userEmail = await getDefaultUser();
          console.log(`🧵 [IMAP Sync] No thread match found. Routing as new thread to user: ${userEmail}, threadId: ${threadId}`);
        }
      }

      // 3. Construct and write the mail object
      const mailId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      
      const mailObj = {
        id: mailId,
        threadId: threadId,
        messageId: messageId,
        from: senderAddr,
        senderEmail: senderAddr,
        to: userEmail,
        receiverEmail: userEmail,
        cc: JSON.stringify(ccList),
        bcc: JSON.stringify(bccList),
        subject: subject,
        message: bodyText, // Plain text content
        body: bodyText,
        html: bodyHtml,
        time: emailDate.toISOString(),
        timestamp: emailDate.getTime(),
        status: "inbox", // Deliver to Inbox
        isRead: false,
        read: false,
        isStarred: false,
        starred: false,
                hasAttachments: attachmentsList.length > 0,
        attachmentCount: attachmentsList.length,
        attachments: JSON.stringify(attachmentsList),
        source: "smtp"
      };

      // Write to GunDB
      console.log(`💾 [IMAP Sync] Writing mail object to GunDB collections (securemail_mails & user_mail_index:${userEmail})...`);
      gun.get("securemail_mails").get(mailId).put(mailObj);
      gun.get(`user_mail_index:${userEmail}`).get(mailId).put(mailObj);

      // 4. Update the Message-ID and Subject Indices
      gun.get("securemail_message_ids").get(messageId.trim()).put({
        dmailId: mailId,
        threadId: threadId,
        userEmail: userEmail,
        subject: subject
      });

      const normSubject = normalizeSubject(subject);
      gun.get("securemail_subject_threads").get(normSubject).put({
        threadId: threadId,
        userEmail: userEmail
      });

      // 5. Mark Message-ID as processed persistently
      gun.get("securemail_processed_message_ids").get(messageId).put(true);
      console.log(`✅ [IMAP Sync] Email processed and saved successfully! ID: ${mailId}`);

    } catch (err) {
      console.error("❌ [IMAP Sync] Error processing incoming email:", err);
    }
  }

  // Run the initial connection
  connect();
}
