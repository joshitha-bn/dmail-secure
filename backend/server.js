import express from "express"
import http from "http"
import Gun from "gun"
import os from "os"
import dotenv from "dotenv"
import multer from "multer"
import nodemailer from "nodemailer"
import { startIMAPSync } from "./imap_sync.js"

dotenv.config()

const app = express()
const server = http.createServer(app)
const PORT = process.env.PORT || 8765

// ── CORS & Security Headers ──
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", CORS_ORIGIN)
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization")
  
  // Security headers
  res.header("X-Content-Type-Options", "nosniff")
  res.header("X-Frame-Options", "DENY")
  res.header("X-XSS-Protection", "1; mode=block")
  res.header("Referrer-Policy", "strict-origin-when-cross-origin")

  if (req.method === "OPTIONS") return res.sendStatus(200)
  next()
})

app.use(express.json())

// ── Health check — confirm server is running ──
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "SecureMail GunDB Relay",
    port: PORT,
    time: new Date().toISOString(),
  })
})

app.get("/health", (req, res) => {
  res.json({ status: "ok", gun: "running", port: PORT })
})

// ── Pinata Global Pinning Proxy ──
const upload = multer({ storage: multer.memoryStorage() })
const PINATA_JWT = process.env.PINATA_JWT || ""

app.get("/pin/status", (req, res) => {
  res.json({ pinataReady: !!PINATA_JWT })
})

app.post("/pin", async (req, res) => {
  if (!PINATA_JWT) return res.status(503).send("Pinata not configured on backend")
  
  try {
    const data = req.body.data
    const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PINATA_JWT}`,
      },
      body: JSON.stringify({
        pinataContent: data,
        pinataOptions: { cidVersion: 1 },
        pinataMetadata: { name: `dmail_json_${Date.now()}` },
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return res.status(response.status).send(err)
    }

    const result = await response.json()
    res.json({ cid: result.IpfsHash })
  } catch (err) {
    res.status(500).send(err.message)
  }
})

app.post("/pin-file", upload.single("file"), async (req, res) => {
  if (!PINATA_JWT) return res.status(503).send("Pinata not configured on backend")
  if (!req.file) return res.status(400).send("No file provided")
  
  try {
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "application/octet-stream" })
    const formData = new FormData()
    formData.append("file", blob, req.file.originalname || `file_${Date.now()}`)
    formData.append("pinataMetadata", JSON.stringify({ name: req.file.originalname || `file_${Date.now()}` }))
    formData.append("pinataOptions", JSON.stringify({ cidVersion: 1 }))

    const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { "Authorization": `Bearer ${PINATA_JWT}` },
      body: formData,
    })

    if (!response.ok) {
      const err = await response.text()
      return res.status(response.status).send(err)
    }

    const result = await response.json()
    res.json({ cid: result.IpfsHash })
  } catch (err) {
    res.status(500).send(err.message)
  }
})

// ── IPFS Fetch Proxy ──
// Allows remote devices to fetch content from this master node's local IPFS daemon
// Bypasses IPFS API CORS and local-only bind restrictions (port 5001/8080)
app.get("/ipfs/:cid", async (req, res) => {
  try {
    // Try to fetch from local Kubo API
    const response = await fetch(`http://127.0.0.1:5001/api/v0/cat?arg=${req.params.cid}`, {
      method: "POST",
      signal: AbortSignal.timeout(5000)
    })
    
    if (!response.ok) {
      return res.status(404).send("Content not found on local master node")
    }
    
    // We stream the response back. For simplicity we assume it's text/json
    // as our app primarily fetches JSON vaults and mails.
    const text = await response.text()
    try {
      res.json(JSON.parse(text))
    } catch {
      res.send(text)
    }
  } catch (err) {
    res.status(500).send(err.message)
  }
})

// ── SMTP Transporter Cache ──
let smtpTransporter = null;

const normalizeSubject = (s) =>
  (s || "(No subject)").replace(/^((Re|Fwd):\s*)+/i, "").trim();

const getSMTPTransporter = () => {
  if (smtpTransporter) return smtpTransporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_EMAIL || process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;

  if (!host || !user || !pass || pass === "your_gmail_app_password_here") {
    throw new Error("❌ [SMTP] Configuration error: SMTP_HOST, SMTP_EMAIL, and SMTP_PASSWORD must be configured in backend/.env.");
  }

  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465 || process.env.SMTP_SECURE === "true",
    auth: {
      user: user,
      pass: pass,
    },
  });
  return smtpTransporter;
};

app.post("/api/send-external", async (req, res) => {
  const { sender, recipient, subject, body, html, cc, bcc, replyTo, attachments, mailId, threadId } = req.body

  if (!recipient || !recipient.includes("@")) {
    return res.status(400).json({ error: "Invalid email address format" })
  }

  // ── Mock Test Routing ──
  if (recipient.endsWith("@test-success.com")) {
    console.log(`🧪 [SMTP Mock] Simulating successful delivery to ${recipient}`)
    const mockMsgId = `<mock-msg-id-${Date.now()}@smtp.ethereal.email>`;
    
    // Index mock outgoing Message-ID to thread mapping for loopback testing
    if (sender) {
      const mapping = {
        dmailId: mailId || `msg_${Date.now()}`,
        threadId: threadId || mailId || `thread_${Date.now()}`,
        userEmail: sender.trim().toLowerCase(),
        subject: subject || ""
      };
      gun.get("securemail_message_ids").get(mockMsgId).put(mapping);
      
      const normSubject = normalizeSubject(subject);
      gun.get("securemail_subject_threads").get(normSubject).put({
        threadId: mapping.threadId,
        userEmail: mapping.userEmail
      });
      console.log(`🔑 [IMAP Mock Sync] Indexed Mock Message-ID: ${mockMsgId} ->`, mapping);
    }
    
    return res.json({ success: true, messageId: mockMsgId })
  }
  if (recipient.endsWith("@test-fail-delivery.com")) {
    console.log(`🧪 [SMTP Mock] Simulating external delivery failure to ${recipient}`)
    return res.status(500).json({ error: "External email delivery failure: SMTP recipient rejected (Simulated)" })
  }
  if (recipient.endsWith("@test-fail-network.com")) {
    console.log(`🧪 [SMTP Mock] Simulating SMTP service unavailable for ${recipient}`)
    return res.status(503).json({ error: "SMTP/service unavailable: Connection timed out (Simulated)" })
  }

  try {
    const transporter = await getSMTPTransporter()
    if (!transporter) {
      console.warn("⚠️ [SMTP] Transporter is unavailable (offline and no env config). Simulating success.")
      return res.json({ success: true, messageId: `offline-mock-${Date.now()}` })
    }

    const cleanMailId = mailId || `msg_${Date.now()}`;
    const generatedMsgId = `<${cleanMailId}@dmail.com>`;
    const resolvedReplyTo = replyTo || process.env.SMTP_EMAIL || process.env.SMTP_USER;

    console.log(`📧 [SMTP] Composing outbound email:`);
    console.log(`   - Sender: ${sender}`);
    console.log(`   - Recipient: ${recipient}`);
    console.log(`   - Subject: "${subject}"`);
    console.log(`   - Message-ID: ${generatedMsgId}`);
    console.log(`   - Reply-To: ${resolvedReplyTo}`);

    const mailOptions = {
      from: process.env.SMTP_FROM || sender,
      to: recipient,
      cc: cc || [],
      bcc: bcc || [],
      replyTo: resolvedReplyTo,
      subject: subject || "(No Subject)",
      text: body,
      html: html || body,
      messageId: generatedMsgId,
      attachments: (attachments || []).map(att => {
        if (att.data) {
          return {
            filename: att.name,
            path: att.data
          }
        }
        return null
      }).filter(Boolean)
    }

    const info = await transporter.sendMail(mailOptions)
    console.log(`📧 [SMTP] Email sent to ${recipient}. MessageId: ${generatedMsgId}`)
    
    // Index outgoing Message-ID to thread mapping for replies
    if (sender) {
      const mapping = {
        dmailId: cleanMailId,
        threadId: threadId || cleanMailId,
        userEmail: sender.trim().toLowerCase(),
        subject: subject || ""
      };
      gun.get("securemail_message_ids").get(generatedMsgId).put(mapping);
      
      const normSubject = normalizeSubject(subject);
      gun.get("securemail_subject_threads").get(normSubject).put({
        threadId: mapping.threadId,
        userEmail: mapping.userEmail
      });
      console.log(`🔑 [SMTP] Indexed Message-ID: ${generatedMsgId} & subject: "${normSubject}" ->`, mapping);
    }

    const previewUrl = nodemailer.getTestMessageUrl(info)
    if (previewUrl) {
      console.log(`🔗 [SMTP] Ethereal Preview URL: ${previewUrl}`)
    }

    return res.json({
      success: true,
      messageId: generatedMsgId,
      previewUrl: previewUrl || undefined
    })
  } catch (err) {
    console.error("❌ [SMTP] SMTP sending failed:", err)
    return res.status(500).json({ error: `External email delivery failure: ${err.message}` })
  }
})

// 🔒 This server IS the relay — it does not peer with external relays.
// All devices on the LAN connect HERE and get the same shared data graph.
// External public relays have their own isolated data graphs — peering with
// them would scatter mail data and cause inbox inconsistency across devices.

// ── Mount Gun on the HTTP server ──
const gun = Gun({
  web: server,          // attach to existing HTTP server
  file: "data",          // persist data to ./data folder
  radisk: true,
  multicast: false,
  // peers: [] intentionally empty — this IS the canonical relay
})

console.log("📡 [Relay] Running as primary relay — all devices should connect to this server")

// ── Gun debug logging (only in development) ──
if (process.env.NODE_ENV !== "production") {
  gun.on("out", { "#": { "*": "" } })
}

// ── Fast Relay WebSocket Layer ──
import { WebSocketServer } from "ws"
const wss = new WebSocketServer({ noServer: true })
const clients = new Map() // email -> socket

wss.on("connection", (ws) => {
  let userEmail = null

  ws.on("message", (message) => {
    try {
      const payload = JSON.parse(message)
      
      if (payload.type === "auth") {
        userEmail = payload.email?.trim().toLowerCase()
        if (userEmail) {
          clients.set(userEmail, ws)
          console.log(`🔌 [Relay] User connected: ${userEmail} (Total: ${clients.size})`)
          ws.send(JSON.stringify({ type: "ready", status: "online" }))
        }
      }

      if (payload.type === "push") {
        const target = payload.recipient?.trim().toLowerCase()
        const recipientSocket = clients.get(target)
        
        if (recipientSocket && recipientSocket.readyState === 1) {
          console.log(`🚀 [Relay] Instant Push: ${userEmail} -> ${target}`)
          recipientSocket.send(JSON.stringify({
            type: "mail",
            sender: userEmail,
            content: payload.content, // Fast-Encrypted (ECC+AES)
            metadata: payload.metadata
          }))
          ws.send(JSON.stringify({ type: "push_ack", id: payload.metadata?.id, status: "delivered" }))
        } else {
          // If recipient is offline, frontend will fallback to GunDB/Nostr (handled in sendMailNow)
          ws.send(JSON.stringify({ type: "push_ack", id: payload.metadata?.id, status: "offline" }))
        }
      }
    } catch (err) {
      console.error("❌ [Relay] Message Error:", err)
    }
  })

  ws.on("close", () => {
    if (userEmail) {
      clients.delete(userEmail)
      console.log(`🔌 [Relay] User disconnected: ${userEmail}`)
    }
  })
})

// Handle upgrade from HTTP to WS
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  const pathname = url.pathname
  
  if (pathname === "/relay") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request)
    })
  } else {
    // 💡 IMPORTANT: If it's not for our custom relay, do NOT block it.
    // Let GunDB's internal WebSocket handler take over (usually on /gun).
    // This allows both the Fast Relay and the Gun Mesh to coexist on the same port.
  }
})

// ── Log all local network IPs so you know which IP to use ──
const getLocalIPs = () => {
  const interfaces = os.networkInterfaces()
  const ips = []
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push(iface.address)
      }
    }
  }
  return ips
}

// ── Startup Verifications ──
try {
  getSMTPTransporter();
} catch (err) {
  console.error("❌ [SMTP] Configuration check failed on startup:", err.message);
  if (process.env.NODE_ENV === "production") {
    process.exit(1);
  } else {
    console.warn("⚠️ [SMTP] Continuing in development mode with simulated fallback.");
  }
}

server.listen(PORT, "0.0.0.0", async () => {
  const ips = getLocalIPs()
  console.log("\n🚀 SecureMail GunDB Relay Server")
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log(`✅ Listening on port ${PORT}`)
  console.log(`✅ Local:   http://localhost:${PORT}/gun`)
  ips.forEach((ip) => {
    console.log(`✅ Network: http://${ip}:${PORT}/gun`)
  })
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log("📌 Use the Network URL for cross-device access\n")

  // 1. Verify SMTP Connection on Startup
  try {
    const transporter = getSMTPTransporter();
    if (transporter) {
      console.log(`⚙️ [SMTP] Verifying SMTP connection to ${process.env.SMTP_HOST} using account ${process.env.SMTP_EMAIL || process.env.SMTP_USER}...`);
      await transporter.verify();
      console.log(`✅ [SMTP] SMTP Connection verified successfully. Using account: ${process.env.SMTP_EMAIL || process.env.SMTP_USER}`);
    }
  } catch (err) {
    console.error("❌ [SMTP] SMTP verification failed on startup:", err.message);
    console.warn("⚠️ [SMTP] Continuing without SMTP — GunDB relay will still work.");
  }

  // Start the background IMAP synchronization service
  startIMAPSync(gun);
})

// ── Graceful Shutdown Handler ──
const shutdown = () => {
  console.log("\n🛑 [Shutdown] Gracefully shutting down services...");
  server.close(() => {
    console.log("✅ [Shutdown] HTTP server closed.");
    process.exit(0);
  });
  
  // Force exit after 10s
  setTimeout(() => {
    console.error("🛑 [Shutdown] Forced shutdown after timeout.");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);