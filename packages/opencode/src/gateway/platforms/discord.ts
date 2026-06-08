import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult, MediaItem } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"
import { cacheImageFromUrl } from "../cache"

export class DiscordAdapter implements PlatformAdapter {
  id = "discord"
  private token: string
  private h?: Handler
  private client: any
  private running = false

  constructor(token: string) {
    this.token = token
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
    const mod = await import("discord.js")
    this.client = new mod.Client({
      intents: [
        mod.GatewayIntentBits.GuildMessages,
        mod.GatewayIntentBits.MessageContent,
        mod.GatewayIntentBits.DirectMessages,
        mod.GatewayIntentBits.Guilds,
      ],
    })
    this.client.on("messageCreate", async (msg: any) => {
      if (msg.author.bot) return

      const media: MediaItem[] = []
      if (msg.attachments?.size > 0) {
        const { cacheImage, cacheVideo, cacheDoc, cacheAudio } = await import("../cache")
        for (const [, att] of msg.attachments) {
          const ct = (att as any).contentType || ""
          const url = (att as any).url
          const name = (att as any).name || "file"
          try {
            if (ct.startsWith("image/")) {
              const cached = await cacheImageFromUrl(url)
              media.push({ type: "photo", mime: ct, url, path: cached, filename: name })
            } else if (ct.startsWith("video/")) {
              const r = await fetch(url, { signal: AbortSignal.timeout(120000) })
              if (r.ok) {
                const buf = new Uint8Array(await r.arrayBuffer())
                const cached = await cacheVideo(buf, ".mp4")
                media.push({ type: "video", mime: ct, url, path: cached, filename: name })
              }
            } else if (ct.startsWith("audio/")) {
              const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
              if (r.ok) {
                const buf = new Uint8Array(await r.arrayBuffer())
                const cached = await cacheAudio(buf, ".ogg")
                const isVoice = msg.flags?.has(1 << 13)
                media.push({ type: isVoice ? "voice" : "audio", mime: ct, url, path: cached, filename: name })
              }
            } else {
              const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
              if (r.ok) {
                const buf = new Uint8Array(await r.arrayBuffer())
                const cached = await cacheDoc(buf, name)
                media.push({ type: "document", mime: ct || "application/octet-stream", url, path: cached, filename: name, size: (att as any).size })
              }
            }
          } catch {}
        }
      }

      h({
        text: msg.content,
        platform: "discord",
        chat: msg.channel.id,
        type: msg.channel.type === 1 ? "dm" : "group",
        user: msg.author.id,
        msgId: msg.id,
        media: media.length > 0 ? media : undefined,
      })
    })
    await this.client.login(this.token)
  }

  async stop() {
    this.running = false
    this.client?.destroy()
  }

  isRunning() { return this.running }

  async sendTyping(chat: string) {
    const ch = await this.client.channels.fetch(chat)
    if (ch?.sendTyping) await ch.sendTyping()
  }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      const ch = await this.client.channels.fetch(chat)
      if (!ch) return { success: false, error: "channel not found" }
      const chunks = paginateChunks(chunkText(text, 2000))
      for (const chunk of chunks) {
        await ch.send(chunk)
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    try {
      const ch = await this.client.channels.fetch(chat)
      if (!ch) return { success: false, error: "channel not found" }
      const msg = await ch.send({ content: opts?.caption || "", files: [filePath] })
      return { success: true, id: msg.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendImage(chat: string, filePath: string, caption?: string): Promise<SendResult> {
    try {
      const ch = await this.client.channels.fetch(chat)
      if (!ch) return { success: false, error: "channel not found" }
      const msg = await ch.send({ content: caption || "", files: [filePath] })
      return { success: true, id: msg.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendVideo(chat: string, filePath: string, caption?: string): Promise<SendResult> {
    try {
      const ch = await this.client.channels.fetch(chat)
      if (!ch) return { success: false, error: "channel not found" }
      const msg = await ch.send({ content: caption || "", files: [filePath] })
      return { success: true, id: msg.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendVoice(chat: string, filePath: string): Promise<SendResult> {
    try {
      const ch = await this.client.channels.fetch(chat)
      if (!ch) return { success: false, error: "channel not found" }
      const msg = await ch.send({ files: [filePath] })
      return { success: true, id: msg.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendDocument(chat: string, filePath: string, filename?: string): Promise<SendResult> {
    try {
      const ch = await this.client.channels.fetch(chat)
      if (!ch) return { success: false, error: "channel not found" }
      const msg = await ch.send({ files: [filePath] })
      return { success: true, id: msg.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}
