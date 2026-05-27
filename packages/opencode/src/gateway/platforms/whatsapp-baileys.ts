import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks, toWhatsAppFormat } from "../adapter"
import path from "path"
import { mkdir, readdir } from "fs/promises"
import { Global } from "../../global"
import { BunProc } from "@/bun"

export class WhatsAppBaileysAdapter implements PlatformAdapter {
  id = "whatsapp"
  private phone: string
  private h?: Handler
  private sock: any
  private running = false
  private dir: string
  private baileysPath = ""
  private logger: any
  private msgStore = new Map<string, any>()
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private sentIds = new Set<string>()
  private connectionOpen = false
  private connectTime = 0

  constructor(phone: string) {
    this.phone = phone
    this.dir = path.join(Global.Path.state, "gateway", "whatsapp-session")
  }

  async start(h: Handler) {
    this.h = h
    await mkdir(this.dir, { recursive: true }).catch(() => {})

    const entries = await readdir(this.dir).catch(() => [] as string[])
    if (entries.length === 0) throw new Error("No session files — pairing required")

    this.baileysPath = await BunProc.install("@whiskeysockets/baileys", "latest")
    const cacheModules = path.resolve(this.baileysPath, "..", "..")

    const [
      baileys,
      { default: P },
      { default: NodeCache },
    ] = await Promise.all([
      import(this.baileysPath),
      import(path.join(cacheModules, "pino")),
      import(path.join(cacheModules, "@cacheable", "node-cache")),
    ])

    const {
      makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      DEFAULT_CONNECTION_CONFIG,
      proto,
      Browsers,
      generateMessageIDV2,
      isJidNewsletter,
    } = baileys

    this.logger = P({
      level: "trace",
      transport: {
        targets: [{
          target: "pino/file",
          options: { destination: path.join(this.dir, "..", "wa-logs.txt") },
          level: "trace",
        }],
      },
    })

    const deps = {
      makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      DEFAULT_CONNECTION_CONFIG,
      proto,
      Browsers,
      generateMessageIDV2,
      isJidNewsletter,
      NodeCache,
    }

    await this.connect(deps)
  }

  private async connect(deps: any) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    this.connectionOpen = false
    const { state, saveCreds } = await deps.useMultiFileAuthState(this.dir)
    const { version } = await deps.fetchLatestBaileysVersion()
    const msgRetryCounterCache = new deps.NodeCache()

    this.sock = deps.makeWASocket({
      version,
      logger: this.logger,
      waWebSocketUrl: deps.DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
      auth: {
        creds: state.creds,
        keys: deps.makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      msgRetryCounterCache,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      browser: deps.Browsers.windows("Chrome"),
      shouldIgnoreJid: (jid: string) => deps.isJidNewsletter(jid) || jid.endsWith("@broadcast"),
      getMessage: async (key: any) => {
        const msg = this.msgStore.get(`${key.remoteJid}:${key.id}`)
        return msg || undefined
      },
    })

    this.sock.ev.process(async (events: any) => {
      if (events["creds.update"]) {
        await saveCreds()
      }

      if (events["connection.update"]) {
        const u = events["connection.update"]

        if (u.connection === "open") {
          this.running = true
          this.connectionOpen = true
          this.connectTime = Date.now()
          this.logger.info("WhatsApp connection opened")
        }

        if (u.connection === "close") {
          this.connectionOpen = false
          const statusCode = (u.lastDisconnect?.error as any)?.output?.statusCode
          if (statusCode === deps.DisconnectReason.loggedOut || !this.h) {
            this.running = false
            this.logger.info("WhatsApp logged out")
            return
          }
          this.logger.info("WhatsApp reconnecting...")
          this.reconnectTimer = setTimeout(() => this.connect(deps), 3000)
        }
      }

      if (events["messages.upsert"]) {
        const upsert = events["messages.upsert"]
        if (upsert.type !== "notify") return
        // Only process messages after connection is fully open
        if (!this.connectionOpen) return

        for (const m of upsert.messages) {
          if (m.key.fromMe) {
            // Track our own sent message IDs to suppress echo-backs
            if (m.key.id) {
              this.sentIds.add(m.key.id)
              if (this.sentIds.size > 50) {
                const first = this.sentIds.values().next().value
                if (first) this.sentIds.delete(first)
              }
            }
            continue
          }
          if (deps.isJidNewsletter(m.key.remoteJid)) continue

          const jid = m.key.remoteJid
          if (!jid || jid.endsWith("@broadcast")) continue

          // Timestamp guard: skip messages older than 60s from connection
          const msgTime = (m.messageTimestamp || 0) * 1000
          if (msgTime > 0 && this.connectTime > 0 && msgTime < this.connectTime - 60000) {
            this.logger.debug({ jid, msgId: m.key.id, age: Date.now() - msgTime }, "skipping old message")
            continue
          }

          if (m.message) {
            this.msgStore.set(`${jid}:${m.key.id}`, m.message)
          }

          const conv =
            m.message?.conversation ||
            m.message?.extendedTextMessage?.text ||
            ""

          const chat = jid
          const type = jid.endsWith("@g.us") ? ("group" as const) : ("dm" as const)

          if (m.message?.imageMessage) {
            const cached = await this.downloadMedia(m)
            this.h?.({
              text: m.message.imageMessage.caption || "",
              platform: "whatsapp",
              chat,
              type,
              user: m.key.participant || jid.split("@")[0],
              msgId: m.key.id,
              media: cached ? [{ url: cached, type: "image" }] : undefined,
            })
          } else if (m.message?.videoMessage) {
            const cached = await this.downloadMedia(m)
            this.h?.({
              text: m.message.videoMessage.caption || "",
              platform: "whatsapp",
              chat,
              type,
              user: m.key.participant || jid.split("@")[0],
              msgId: m.key.id,
              media: cached ? [{ url: cached, type: "video" }] : undefined,
            })
          } else if (m.message?.audioMessage || m.message?.pttMessage) {
            const cached = await this.downloadMedia(m)
            this.h?.({
              text: "",
              platform: "whatsapp",
              chat,
              type,
              user: m.key.participant || jid.split("@")[0],
              msgId: m.key.id,
              media: cached ? [{ url: cached, type: "audio" }] : undefined,
            })
          } else if (m.message?.documentMessage) {
            const cached = await this.downloadMedia(m)
            this.h?.({
              text: m.message.documentMessage.caption || "",
              platform: "whatsapp",
              chat,
              type,
              user: m.key.participant || jid.split("@")[0],
              msgId: m.key.id,
              media: cached ? [{ url: cached, type: "document" }] : undefined,
            })
          } else if (conv) {
            this.h?.({
              text: conv,
              platform: "whatsapp",
              chat,
              type,
              user: m.key.participant || jid.split("@")[0],
              msgId: m.key.id,
            })
          }
        }
      }
    })
  }

  private async downloadMedia(m: any): Promise<string | undefined> {
    try {
      const { downloadMediaMessage } = await import(this.baileysPath)
      const buf = await downloadMediaMessage(m, "buffer", {}, {})
      const arr = new Uint8Array(buf)
      const { cacheImage, cacheVideo, cacheAudio, cacheDoc } = await import("../cache")
      if (m.message.imageMessage) return cacheImage(arr, ".jpg")
      if (m.message.videoMessage) return cacheVideo(arr, ".mp4")
      if (m.message.audioMessage || m.message.pttMessage) return cacheAudio(arr, ".ogg")
      if (m.message.documentMessage) return cacheDoc(arr, m.message.documentMessage.fileName || "file")
      return undefined
    } catch { return undefined }
  }

  async stop() {
    this.running = false
    this.connectionOpen = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    try { this.sock?.end?.() } catch {}
  }

  isRunning() { return this.running }

  async sendTyping(chat: string) {
    await this.sock.sendPresenceUpdate("composing", chat)
  }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      const waText = toWhatsAppFormat(text)
      const chunks = paginateChunks(chunkText(waText, 4096))
      for (const chunk of chunks) {
        const id = this.sock.generateMessageIDV2?.(this.sock.user?.id)
        await this.sock.sendMessage(chat, { text: chunk }, id ? { messageId: id } : undefined)
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    try {
      const ext = path.extname(filePath).toLowerCase()
      const img = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)
      const vid = [".mp4", ".mov", ".webm"].includes(ext)
      const aud = [".ogg", ".opus", ".mp3", ".m4a"].includes(ext)
      const file = Bun.file(filePath)
      const arr = new Uint8Array(await file.arrayBuffer())

      let r: any
      if (img) r = await this.sock.sendMessage(chat, { image: arr, caption: opts?.caption })
      else if (vid) r = await this.sock.sendMessage(chat, { video: arr, caption: opts?.caption })
      else if (aud) r = await this.sock.sendMessage(chat, { audio: arr, mimetype: "audio/mp4" })
      else r = await this.sock.sendMessage(chat, { document: arr, fileName: path.basename(filePath), caption: opts?.caption })
      return { success: true, id: r?.key?.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}
