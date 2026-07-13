import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { sender, recipient, subject, body: messageBody, attachments, mailId, threadId } = body;

    if (!sender || !recipient || !subject || !messageBody) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Setup Nodemailer transporter using environment variables
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_EMAIL || "etherxinnovdmail@gmail.com",
        pass: process.env.SMTP_PASSWORD || "hhnxsxkjpretvpzn",
      },
    });

    // Format attachments for Nodemailer
    const mailAttachments = attachments ? attachments.map((att: any) => {
      // If data is a base64 string or data URL
      let content = att.data;
      if (typeof content === 'string' && content.startsWith('data:')) {
        content = content.split(',')[1];
      }
      return {
        filename: att.name,
        content: content,
        encoding: 'base64'
      };
    }) : [];

    // Send the email
    const info = await transporter.sendMail({
      from: `"${sender}" <${process.env.SMTP_EMAIL || "etherxinnovdmail@gmail.com"}>`,
      replyTo: sender,
      to: recipient,
      subject: subject,
      text: messageBody,
      html: messageBody.replace(/\n/g, "<br>"), // Simple text to HTML
      attachments: mailAttachments,
    });

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error("API /send-external error:", error);
    return NextResponse.json({ error: error.message || "Failed to send email" }, { status: 500 });
  }
}
