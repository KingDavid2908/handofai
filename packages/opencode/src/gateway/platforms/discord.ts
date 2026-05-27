import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
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
    this.client.on("messageCreate", (msg: any) => {
      if (msg.author.bot) return
      const m: Parameters<Handler>[0] = {
        text: msg.content,
        platform: "discord",
        chat: msg.channel.id,
        type: msg.channel.type === 1 ? "dm" : "group",
        user: msg.author.id,
        msgId: msg.id,
      }
      if (msg.attachments?.size > 0) {
        m.media = []
        for (const [, att] of msg.attachments) {
          if ((att as any).contentType?.startsWith("image/")) {
            cacheImageFromUrl((att as any).url).then((cached) => {
              m.media!.push({ url: cached, type: "image" })
            }).catch(() => {})
          }
        }
      }
      h(m)
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

  async sendMedia(chat: string, path: string, opts?: SendMediaOpts): Promise<SendResult> {
    try {
      const ch = await this.client.channels.fetch(chat)
      if (!ch) return { success: false, error: "channel not found" }
      const msg = await ch.send({ content: opts?.caption || "", files: [path] })
      return { success: true, id: msg.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}
