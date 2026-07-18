import { NextResponse } from "next/server";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export const dynamic = "force-dynamic";

// Extract DMail username from a Gmail plus-address like:
//   etherxinnovdmail+joshitha1234@gmail.com  →  joshitha1234@dmail.com
// Falls back to null if no plus-tag is present.
function extractDmailRecipient(toAddresses: any[]): string | null {
  if (!toAddresses || toAddresses.length === 0) return null;
  for (const addr of toAddresses) {
    const address: string = addr.address || "";
    const plusMatch = address.match(/^[^+]+\+([^@]+)@/);
    if (plusMatch) {
      const tag = plusMatch[1]; // e.g. "joshitha1234"
      return `${tag}@dmail.com`;
    }
  }
  return null;
}

export async function GET() {
  try {
    const host = process.env.IMAP_HOST || "imap.gmail.com";
    const port = parseInt(process.env.IMAP_PORT || "993");
    const secure = process.env.IMAP_SECURE !== "false";
    const user = process.env.IMAP_USER || process.env.SMTP_EMAIL || process.env.SMTP_USER;
    const pass = process.env.IMAP_PASSWORD || process.env.IMAP_PASS || process.env.SMTP_PASSWORD || process.env.SMTP_PASS;

    if (!user || !pass) {
      return NextResponse.json({ error: "IMAP credentials are not configured on Vercel." }, { status: 500 });
    }

    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: false,
    });

    await client.connect();

    const lock = await client.getMailboxLock("INBOX");
    const newEmails: any[] = [];

    try {
      // Fetch only unread messages
      const messagesGenerator = await client.fetch({ seen: false }, { envelope: true, source: true, uid: true });

      for await (const msg of messagesGenerator) {
        if (!msg.source) continue;

        const parsed = await simpleParser(msg.source);

        const senderObj = parsed.from?.value?.[0] || {};
        const senderAddr = senderObj.address || "unknown@external.com";
        const subject = parsed.subject || "(No Subject)";
        const bodyText = parsed.text || "";
        const bodyHtml = parsed.html || "";
        const emailDate = parsed.date || new Date();
        const messageId = parsed.messageId || `<unknown-${msg.uid}@dmail>`;

        // Determine intended DMail recipient via Gmail plus-addressing
        // e.g. To: etherxinnovdmail+joshitha1234@gmail.com → joshitha1234@dmail.com
        const toAddresses = parsed.to
          ? (Array.isArray(parsed.to.value) ? parsed.to.value : [parsed.to.value])
          : [];
        const intendedRecipient = extractDmailRecipient(toAddresses);

        // Parse attachments
        const attachmentsList: any[] = [];
        if (parsed.attachments && parsed.attachments.length > 0) {
          for (const att of parsed.attachments) {
            if (process.env.PINATA_JWT) {
              try {
                const blob = new Blob([att.content], { type: att.contentType || "application/octet-stream" });
                const formData = new FormData();
                formData.append("file", blob, att.filename || `file_${Date.now()}`);

                const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${process.env.PINATA_JWT}` },
                  body: formData as any,
                });

                if (response.ok) {
                  const result = await response.json();
                  attachmentsList.push({
                    name: att.filename || "Attachment",
                    type: "ipfs",
                    cid: result.IpfsHash,
                    size: att.size || att.content.length
                  });
                }
              } catch (e) {
                console.error("Vercel IMAP Pinata upload error:", e);
              }
            } else {
              attachmentsList.push({
                name: att.filename || "Attachment",
                type: "base64",
                data: `data:${att.contentType};base64,${att.content.toString("base64")}`,
                size: att.size || att.content.length
              });
            }
          }
        }

        newEmails.push({
          messageId,
          from: senderAddr,
          // intendedRecipient is the @dmail.com address parsed from Gmail plus-tag.
          // null means no plus-tag → deliver to whichever user is polling.
          to: intendedRecipient,
          subject,
          text: bodyText,
          html: bodyHtml,
          date: emailDate.toISOString(),
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
          attachments: attachmentsList
        });

        // Mark as read so we don't fetch it again on the next poll
        await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
      await client.logout();
    }

    return NextResponse.json({ success: true, count: newEmails.length, emails: newEmails });
  } catch (error: any) {
    console.error("Vercel API /receive-external error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to sync IMAP server" },
      { status: 500 }
    );
  }
}
