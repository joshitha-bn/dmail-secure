"use client"
import dynamic from "next/dynamic"
import { useState, useEffect, useRef, Suspense } from "react"
import { usePathname, useRouter } from "next/navigation"
import Header from "@/components/Header"
import Sidebar from "@/components/Sidebar"
import { initMailStore, updateMailInStore, getAllRaw } from "@/utils/mailStore"
import { initLabelSync } from "@/utils/labelStore"
import { db } from "@/utils/gun"
import { LabelProvider } from "@/context/LabelContext"
import RouteProgressBar from "@/components/RouteProgressBar"
import MobileNav from "@/components/MobileNav"

// 🚀 Lazy Load heavy components that aren't immediately critical
const GunStatusBanner = dynamic(() => import("@/components/GunStatusBanner"), { ssr: false })
const OfflineQueueProcessor = dynamic(() => import("@/components/offlineQueueProcessor"), { ssr: false })
const ComposeWindow = dynamic(() => import("@/components/ComposeWindow"), { ssr: false })

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [showCompose, setShowCompose] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const router = useRouter()
  const pathname = usePathname()
  const isInitialized = useRef(false)

  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth <= 768;
      setIsMobile(mobile);
      if (mobile) setIsSidebarOpen(false);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);

    // Close sidebar when backdrop is tapped on mobile
    const handleClose = () => setIsSidebarOpen(false);
    document.addEventListener('closeSidebar', handleClose);

    return () => {
      window.removeEventListener('resize', checkMobile);
      document.removeEventListener('closeSidebar', handleClose);
    };
  }, [])

  // 1. Initial Data Setup (Run once)
  useEffect(() => {
    if (isInitialized.current) return
    isInitialized.current = true

    let user: any = {}
    try {
      const rawUser = localStorage.getItem("user")
      if (rawUser) {
        user = JSON.parse(rawUser)
      }
    } catch (e) {
      console.warn("Corrupted user localStorage in layout, resetting...")
      if (typeof window !== "undefined") {
        localStorage.removeItem("user")
      }
    }
    if (!user?.email) {
      router.push("/login")
      return
    }
    
    initMailStore(user.email)
    initLabelSync(user.email)
    
    // ⚡ [Fast Path] Initialize Real-Time Relay
    if (user.email && user.fastPublicKey && user.fastPrivateKey) {
      import("@/utils/relay").then(m => {
        m.connectRelay(user.email, { public: user.fastPublicKey, private: user.fastPrivateKey })
      })
    }
    
    // 🌍 Decentralized Heartbeats
    db.reannounceUser()
    db.startIdentityHeartbeat()

    // 🔑 Nostr Setup (Lazy loaded inside)
    if (user.email && user.password) {
      import("@/utils/nostr").then(({ nostr }) => {
        nostr.initUserKeys(user.email, user.password).then(() => {
          nostr.onMail(async (mail: any) => {
            if (!mail?.id && !mail?.subject) return
            const { gun } = await import("@/utils/gun")
            const { filterIncomingMail } = await import("@/utils/spamFilter")
            
            const id = mail.id || `nostr_${Date.now()}_${Math.random().toString(36).slice(2)}`
            
            const existingMail = getAllRaw().find(m => m.id === id)
            let finalStatus = mail.status || "inbox"
            let finalFlaggedReason = mail.flaggedReason
            let finalSpamScore = mail.spamScore

            if (!existingMail || existingMail.spamScore === undefined) {
              const decision = await filterIncomingMail(mail, user.email)
              finalStatus = decision.status || "inbox"
              finalFlaggedReason = decision.flaggedReason
              finalSpamScore = decision.spamScore
            } else {
              finalStatus = existingMail.status
              finalFlaggedReason = existingMail.flaggedReason
              finalSpamScore = existingMail.spamScore
            }
            
            const indexEntry = {
              ...mail,
              id,
              status: finalStatus,
              senderStatus: mail.senderEmail?.toLowerCase() === user.email?.toLowerCase() ? "sent" : undefined,
              flaggedReason: finalFlaggedReason,
              spamScore: finalSpamScore,
              fromNostr: true,
              isRead: existingMail ? existingMail.isRead : false,
            }

            const receiverEmail = mail.receiverEmail?.trim().toLowerCase()
            const senderEmail = mail.senderEmail?.trim().toLowerCase()
            if (receiverEmail) gun.get(`user_mail_index:${receiverEmail}`).get(id).put(indexEntry)
            if (senderEmail && senderEmail !== receiverEmail) gun.get(`user_mail_index:${senderEmail}`).get(id).put({ ...indexEntry, status: "sent", senderStatus: "sent" })
            
            const { receiverPublicKey, ...mailToStore } = indexEntry as any
            gun.get("securemail_mails").get(id).put({ ...mailToStore, id })
          })
          db.reannounceUser()
        }).catch(e => console.warn("[Nostr] Key init failed:", e))
      })
    }

    // 📡 IPFS Discovery
    if (user.publicKey) {
      import("@/utils/ipfs").then(mod => {
        mod.startDiscoveryPubSub(user.email, user.publicKey)
      })
    }
  }, [])

  // 2. Background Maintenance (Throttle to reduce CPU)
  useEffect(() => {
    const interval = setInterval(async () => {
      if (document.hidden) return

      const user = JSON.parse(localStorage.getItem("user") || "{}")
      if (!user.email) return

      const now = Date.now()
      const allMails = getAllRaw()

      for (let i = 0; i < allMails.length; i++) {
        const mail = allMails[i]
        if (!mail?.id) continue
        
        if (mail.expiryTime && now > mail.expiryTime) {
          updateMailInStore(mail.id, { status: "purged" })
        } else if (mail.status === "snoozed" && mail.snoozeUntil && now > mail.snoozeUntil) {
          updateMailInStore(mail.id, { status: "inbox", snoozeUntil: null })
        }
      }

      // Process Outbox
      const scheduledKey = `scheduled_${user.email}`
      const scheduledMails = JSON.parse(localStorage.getItem(scheduledKey) || "[]")
      if (scheduledMails.length > 0) {
        let hasChanges = false
        const remaining = []

        for (const sMail of scheduledMails) {
          if (now >= sMail.targetTime) {
            try {
              const dispatchMail = { ...sMail, time: new Date().toLocaleString() }
              delete dispatchMail.targetTime
              delete dispatchMail.targetTimeText
              delete dispatchMail.id
              await db.sendMail(dispatchMail)
              hasChanges = true
            } catch (err) {
              remaining.push(sMail)
            }
          } else {
            remaining.push(sMail)
          }
        }

        if (hasChanges) {
          localStorage.setItem(scheduledKey, JSON.stringify(remaining))
          window.dispatchEvent(new Event("storage"))
        }
      }
    }, 60000) 

    return () => clearInterval(interval)
  }, [])

  // 3. Compose Toggle Listener
  useEffect(() => {
    const handleOpenCompose = () => setShowCompose(true)
    window.addEventListener("openCompose", handleOpenCompose)
    return () => window.removeEventListener("openCompose", handleOpenCompose)
  }, [])

  return (
    <LabelProvider>
      <RouteProgressBar />
      <GunStatusBanner />
      <div className="dashboard">
        <Header
          onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
          onCompose={() => setShowCompose(true)}
        />
        <div className="dashboard-body">
          <Sidebar
            isOpen={isSidebarOpen}
            onCompose={() => setShowCompose(true)}
          />
          <main 
            className="mail-area" 
            key={pathname}
            style={{ 
              animation: "fadeIn 0.3s ease-out",
              height: "100%", overflow: "hidden",
              paddingBottom: isMobile ? "64px" : "0" // reserve space for mobile nav
            }}
          >
            <Suspense fallback={null}>
              {children}
            </Suspense>
          </main>
        </div>

        {isMobile && <MobileNav onCompose={() => setShowCompose(true)} />}

        <OfflineQueueProcessor />

        {showCompose && (
          <ComposeWindow onClose={() => setShowCompose(false)} />
        )}
      </div>
    </LabelProvider>
  )
}
