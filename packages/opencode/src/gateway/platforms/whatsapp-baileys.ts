import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult, MediaItem } from "../adapter"
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

        // Step 1: filter valid messages and build lightweight descriptors
        const descriptors: Array<{
          m: any
          chat: string
          type: "dm" | "group"
          user: string
          msgId: string
          text: string
          hasMedia: boolean
        }> = []

        for (const m of upsert.messages) {
          if (m.key.fromMe) {
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

          const msgTime = (m.messageTimestamp || 0) * 1000
          if (msgTime > 0 && this.connectTime > 0 && msgTime < this.connectTime - 60000) {
            this.logger.debug({ jid, msgId: m.key.id, age: Date.now() - msgTime }, "skipping old message")
            continue
          }

          if (m.message) {
            this.msgStore.set(`${jid}:${m.key.id}`, m.message)
          }

          const conv = m.message?.conversation || m.message?.extendedTextMessage?.text || ""
          const chat = jid
          const type = jid.endsWith("@g.us") ? ("group" as const) : ("dm" as const)
          const user = m.key.participant || jid.split("@")[0]

          if (m.message?.imageMessage) {
            descriptors.push({ m, chat, type, user, msgId: m.key.id, text: m.message.imageMessage.caption || "", hasMedia: true })
          } else if (m.message?.videoMessage) {
            descriptors.push({ m, chat, type, user, msgId: m.key.id, text: m.message.videoMessage.caption || "", hasMedia: true })
          } else if (m.message?.audioMessage) {
            descriptors.push({ m, chat, type, user, msgId: m.key.id, text: "", hasMedia: true })
          } else if (m.message?.documentMessage) {
            descriptors.push({ m, chat, type, user, msgId: m.key.id, text: m.message.documentMessage.caption || "", hasMedia: true })
          } else if (m.message?.stickerMessage) {
            descriptors.push({ m, chat, type, user, msgId: m.key.id, text: "", hasMedia: true })
          } else if (conv) {
            descriptors.push({ m, chat, type, user, msgId: m.key.id, text: conv, hasMedia: false })
          }
        }

        // Step 2: download all media in parallel
        const mediaResults = await Promise.all(
          descriptors.map(async (d) => {
            if (!d.hasMedia) return null
            return this.downloadMedia(d.m)
          })
        )

        // Step 3: build Msgs
        const msgs: import("../adapter").Msg[] = []
        for (let i = 0; i < descriptors.length; i++) {
          const d = descriptors[i]
          const item = mediaResults[i]
          let media = item ? [item] : undefined

          if (d.m.message?.audioMessage && media?.length) {
            const isVoice = !!d.m.message.audioMessage.ptt
            media = [{ ...media[0], type: isVoice ? "voice" : "audio" }]
          }
          if (d.m.message?.stickerMessage && media?.length) {
            media = [{ ...media[0], type: "sticker" }]
          }

          msgs.push({
            text: d.text,
            platform: "whatsapp",
            chat: d.chat,
            type: d.type,
            user: d.user,
            msgId: d.msgId,
            media,
          })
        }

        // Step 4: group by chat and merge same-chat messages
        const byChat = new Map<string, import("../adapter").Msg[]>()
        for (const msg of msgs) {
          const arr = byChat.get(msg.chat) || []
          arr.push(msg)
          byChat.set(msg.chat, arr)
        }

        for (const [, chatMsgs] of byChat) {
          if (chatMsgs.length === 1) {
            this.h?.(chatMsgs[0])
          } else {
            const texts: string[] = []
            const media: import("../adapter").MediaItem[] = []
            for (const m of chatMsgs) {
              if (m.text) texts.push(m.text)
              if (m.media?.length) media.push(...m.media)
            }
            this.h?.({
              ...chatMsgs[0],
              text: texts.join("\n"),
              media: media.length > 0 ? media : undefined,
            })
          }
        }
      }
    })
  }

  private async downloadMedia(m: any): Promise<MediaItem | undefined> {
    try {
      const { downloadMediaMessage } = await import(this.baileysPath)
      const buf = await downloadMediaMessage(m, "buffer", {}, {})
      const arr = new Uint8Array(buf)
      const { cacheImage, cacheVideo, cacheAudio, cacheDoc } = await import("../cache")

      if (m.message.imageMessage) {
        const path = await cacheImage(arr, ".jpg")
        return { type: "photo", mime: "image/jpeg", path, filename: "image.jpg" }
      }
      if (m.message.videoMessage) {
        const path = await cacheVideo(arr, ".mp4")
        return { type: "video", mime: "video/mp4", path, filename: "video.mp4", caption: m.message.videoMessage.caption }
      }
      if (m.message.audioMessage) {
        const ext = ".ogg"
        const mime = "audio/ogg"
        const path = await cacheAudio(arr, ext)
        return { type: "audio", mime, path, filename: `audio${ext}` }
      }
      if (m.message.documentMessage) {
        const name = m.message.documentMessage.fileName || "file"
        const mime = m.message.documentMessage.mimetype || "application/octet-stream"
        const path = await cacheDoc(arr, name)
        return { type: "document", mime, path, filename: name, size: m.message.documentMessage.fileLength }
      }
      if (m.message.stickerMessage) {
        const path = await cacheImage(arr, ".webp")
        return { type: "sticker", mime: "image/webp", path, filename: "sticker.webp" }
      }
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

  async sendImage(chat: string, filePath: string, caption?: string): Promise<SendResult> {
    try {
      const file = Bun.file(filePath)
      const arr = new Uint8Array(await file.arrayBuffer())
      const r = await this.sock.sendMessage(chat, { image: arr, caption })
      return { success: true, id: r?.key?.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendVideo(chat: string, filePath: string, caption?: string): Promise<SendResult> {
    try {
      const file = Bun.file(filePath)
      const arr = new Uint8Array(await file.arrayBuffer())
      const r = await this.sock.sendMessage(chat, { video: arr, caption })
      return { success: true, id: r?.key?.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendVoice(chat: string, filePath: string): Promise<SendResult> {
    try {
      const file = Bun.file(filePath)
      const arr = new Uint8Array(await file.arrayBuffer())
      const r = await this.sock.sendMessage(chat, { audio: arr, ptt: true, mimetype: "audio/ogg; codecs=opus" })
      return { success: true, id: r?.key?.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendDocument(chat: string, filePath: string, filename?: string): Promise<SendResult> {
    try {
      const file = Bun.file(filePath)
      const arr = new Uint8Array(await file.arrayBuffer())
      const name = filename || path.basename(filePath)
      const r = await this.sock.sendMessage(chat, { document: arr, fileName: name, mimetype: file.type })
      return { success: true, id: r?.key?.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}
