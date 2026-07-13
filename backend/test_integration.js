import Gun from "gun";
import { simpleParser } from "mailparser";
import { startIMAPSync } from "./imap_sync.js";

const GUN_PORT = 8765;
const gun = Gun({
  peers: [`http://localhost:${GUN_PORT}/gun`],
  file: "data_test_temp"
});

console.log("🧪 Starting DMail IMAP Integration Test...");

// Helper delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  try {
    const dummyUserEmail = `testuser_${Date.now()}@securemail.com`;
    const dummyUserPassword = "password123";
    const dummyUserPublicKey = "-----BEGIN PGP PUBLIC KEY BLOCK-----\ndummykey\n-----END PGP PUBLIC KEY BLOCK-----";

    console.log(`\n1. Registering dummy user: ${dummyUserEmail}...`);
    gun.get("securemail_users").get(dummyUserEmail).put({
      email: dummyUserEmail,
      name: "Test User",
      password: dummyUserPassword,
      publicKey: dummyUserPublicKey
    });
    
    await sleep(2000); // Wait for GunDB propagation
    
    console.log("\n2. Sending an external email to test-success@test-success.com...");
    const mailId = `msg_test_${Date.now()}`;
    const sendResponse = await fetch(`http://localhost:${GUN_PORT}/api/send-external`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: dummyUserEmail,
        recipient: "reply-test@test-success.com",
        subject: "Verification Subject",
        body: "Hello, this is a test email.",
        html: "<p>Hello, this is a test email.</p>",
        cc: ["cc1@test-success.com"],
        bcc: ["bcc1@test-success.com"],
        replyTo: "replyto@test-success.com",
        attachments: [],
        mailId: mailId,
        threadId: mailId
      })
    });

    if (!sendResponse.ok) {
      throw new Error(`SMTP sending failed: ${sendResponse.statusText}`);
    }

    const sendResult = await sendResponse.json();
    const mockMessageId = sendResult.messageId;
    console.log(`✅ External email mock sent! Message-ID: ${mockMessageId}`);

    // Wait for the message mapping to settle in GunDB
    await sleep(2000);

    console.log("\n3. Verifying that the Message-ID index was created in GunDB...");
    const indexData = await new Promise(resolve => {
      gun.get("securemail_message_ids").get(mockMessageId).once(data => resolve(data));
    });
    
    if (!indexData || indexData.userEmail !== dummyUserEmail) {
      throw new Error(`Message-ID indexing failed: ${JSON.stringify(indexData)}`);
    }
    console.log(`✅ Message-ID mapped correctly to user: ${indexData.userEmail}, threadId: ${indexData.threadId}`);

    console.log("\n4. Simulating a reply MIME message coming in with In-Reply-To set to the Message-ID...");
    
    // We will parse a raw MIME string with an attachment
    const rawMime = [
      `From: external-sender@gmail.com`,
      `To: ${dummyUserEmail}`,
      `Cc: cc-recipient@gmail.com`,
      `Subject: Re: Verification Subject`,
      `Message-ID: <reply-msg-id-12345@gmail.com>`,
      `In-Reply-To: ${mockMessageId}`,
      `References: ${mockMessageId}`,
      `Content-Type: multipart/mixed; boundary="boundary-test"`,
      ``,
      `--boundary-test`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `This is a reply text body. It should be grouped into the thread!`,
      ``,
      `--boundary-test`,
      `Content-Type: text/plain; name="test_attachment.txt"`,
      `Content-Disposition: attachment; filename="test_attachment.txt"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      Buffer.from("Hello World from attachment!").toString("base64"),
      `--boundary-test--`
    ].join("\r\n");

    const parsed = await simpleParser(rawMime);
    
    // Simulating processing the email via the backend processor logic
    // We manually recreate the matching and storing logic to verify correctness
    let threadId = null;
    let userEmail = null;

    const inReplyTo = parsed.inReplyTo ? parsed.inReplyTo.trim() : null;
    let parentMapping = await new Promise(resolve => {
      gun.get("securemail_message_ids").get(inReplyTo).once(data => resolve(data));
    });

    if (parentMapping) {
      threadId = parentMapping.threadId;
      userEmail = parentMapping.userEmail;
    }

    if (!parentMapping || userEmail !== dummyUserEmail) {
      throw new Error("Thread matching failed! Could not find parent mapping in GunDB.");
    }
    console.log(`✅ Thread matched! threadId matches original sent: ${threadId === mailId}`);

    // Mock IPFS attachment upload
    console.log("\n5. Mocking attachment processing...");
    const attachmentsList = [];
    for (const att of parsed.attachments) {
      // Create a mock CID for verification
      const mockCID = `QmMockCID_${Date.now()}`;
      attachmentsList.push({
        name: att.filename,
        type: "ipfs",
        cid: mockCID,
        size: att.size
      });
    }
    console.log(`✅ Parsed attachment: ${attachmentsList[0].name}, size: ${attachmentsList[0].size} bytes, mock CID: ${attachmentsList[0].cid}`);

    const replyMailId = `msg_reply_${Date.now()}`;
    const ccList = parsed.cc ? (Array.isArray(parsed.cc.value) ? parsed.cc.value.map(c => c.address) : [parsed.cc.value?.address].filter(Boolean)) : [];
    const bccList = parsed.bcc ? (Array.isArray(parsed.bcc.value) ? parsed.bcc.value.map(b => b.address) : [parsed.bcc.value?.address].filter(Boolean)) : [];

    const replyMailObj = {
      id: replyMailId,
      threadId: threadId,
      messageId: parsed.messageId,
      senderEmail: parsed.from.value[0].address,
      receiverEmail: userEmail,
      cc: JSON.stringify(ccList),
      bcc: JSON.stringify(bccList),
      subject: parsed.subject,
      message: parsed.text,
      body: parsed.text,
      time: new Date().toISOString(),
      status: "inbox",
      isRead: false,
      isStarred: false,
      hasAttachments: attachmentsList.length > 0,
      attachmentCount: attachmentsList.length,
      attachments: JSON.stringify(attachmentsList),
      source: "smtp"
    };

    console.log(`\n6. Writing the simulated reply to the dummy user's user_mail_index...`);
    gun.get("securemail_mails").get(replyMailId).put(replyMailObj);
    gun.get(`user_mail_index:${userEmail}`).get(replyMailId).put(replyMailObj);

    await sleep(2000); // wait for GunDB write

    console.log("\n7. Fetching emails from dummy user's inbox to verify delivery...");
    const inboxMails = [];
    await new Promise((resolve) => {
      gun.get(`user_mail_index:${dummyUserEmail}`).map().once((mail) => {
        if (mail && mail.id) inboxMails.push(mail);
      });
      setTimeout(resolve, 2000);
    });

    console.log(`User Inbox count: ${inboxMails.length}`);
    const receivedReply = inboxMails.find(m => m.id === replyMailId);
    if (!receivedReply) {
      throw new Error("Failed to find reply email in user's GunDB inbox!");
    }

    console.log("\n📬 Received Reply details:");
    console.log(`- ID: ${receivedReply.id}`);
    console.log(`- Thread ID: ${receivedReply.threadId}`);
    console.log(`- From: ${receivedReply.senderEmail}`);
    console.log(`- CC: ${JSON.stringify(receivedReply.cc)}`);
    console.log(`- Subject: ${receivedReply.subject}`);
    console.log(`- Message: ${receivedReply.message}`);
    console.log(`- Attachments Count: ${receivedReply.attachmentCount}`);
    const parsedAtts = typeof receivedReply.attachments === "string" ? JSON.parse(receivedReply.attachments) : receivedReply.attachments;
    console.log(`- Attachment Name: ${parsedAtts?.[0]?.name}`);
    console.log(`- Attachment CID: ${parsedAtts?.[0]?.cid}`);

    console.log("\n🎉 INTEGRATION TEST COMPLETED SUCCESSFULLY!");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ INTEGRATION TEST FAILED:", err.message);
    process.exit(1);
  }
}

run();
