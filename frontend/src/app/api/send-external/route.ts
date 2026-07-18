import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

const getSMTPTransporter = () => {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = parseInt(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_EMAIL || process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;

  if (!user || !pass) {
    throw new Error("SMTP credentials are not configured on Vercel.");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465 || process.env.SMTP_SECURE === "true",
    auth: {
      user: user,
      pass: pass,
    },
  });
};

const normalizeSubject = (s: string) => (s || "(No subject)").replace(/^((Re|Fwd):\s*)+/i, "").trim();

export async function POST(req: Request) {
  try {
    const { sender, recipient, subject, body, html, cc, bcc, replyTo, attachments, mailId, threadId } = await req.json();

    if (!recipient || !recipient.includes("@")) {
      return NextResponse.json({ error: "Invalid email address format" }, { status: 400 });
    }

    const transporter = getSMTPTransporter();
    
    const cleanMailId = mailId || `msg_${Date.now()}`;
    const generatedMsgId = `<${cleanMailId}@dmail.com>`;

    const smtpFromAddress = process.env.SMTP_FROM || process.env.SMTP_EMAIL || process.env.SMTP_USER;
    const resolvedReplyTo = replyTo || sender || process.env.SMTP_EMAIL || process.env.SMTP_USER;

    const mailOptions = {
      from: smtpFromAddress,
      to: recipient,
      cc: cc || [],
      bcc: bcc || [],
      replyTo: resolvedReplyTo,
      subject: subject || "(No Subject)",
      text: body,
      html: html || body,
      messageId: generatedMsgId,
      attachments: (attachments || []).map((att: any) => {
        if (att.data) {
          return { filename: att.name, path: att.data };
        }
        return null;
      }).filter(Boolean)
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`[Vercel SMTP] Sent to ${recipient} (MessageID: ${generatedMsgId})`);

    // Note: We don't have access to the local gun instance here on Vercel,
    // so the client must handle indexing the outgoing message into its own gun DB graph.
    // The previous backend proxy did this, but in a decentralized model, the client should do it anyway.

    return NextResponse.json({
      success: true,
      messageId: generatedMsgId,
    });
  } catch (error: any) {
    console.error("Vercel API /send-external error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to reach mail server" },
      { status: 500 }
    );
  }
}

