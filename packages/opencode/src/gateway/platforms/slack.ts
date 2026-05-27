import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class SlackAdapter implements PlatformAdapter {
  id = "slack"
  private token: string
  private appToken: string
  private h?: Handler
  private client: any
  private socket: any
  private running = false

  constructor(token: string, cfg: Record<string, any>) {
    this.token = token
    this.appToken = cfg.app_token || ""
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
    const { WebClient } = await import("@slack/web-api")
    const { SocketModeClient } = await import("@slack/socket-mode")
    this.client = new WebClient(this.token)
    this.socket = new SocketModeClient({ appToken: this.appToken })

    this.socket.on("message", async ({ event, ack }: any) => {
      await ack()
      if (event.type !== "message" || event.bot_id || event.subtype) return
      h({
        text: event.text || "",
        platform: "slack",
        chat: event.channel,
        type: event.channel_type === "im" ? "dm" : event.channel_type === "channel" ? "channel" : "group",
        user: event.user,
        msgId: event.ts,
      })
    })

    await this.socket.start()
  }

  async stop() {
    this.running = false
    try { await this.socket?.disconnect() } catch {}
  }

  isRunning() { return this.running }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      const chunks = paginateChunks(chunkText(text, 40000))
      for (const chunk of chunks) {
        const r = await this.client.chat.postMessage({ channel: chat, text: chunk })
        if (!r.ok) return { success: false, error: r.error }
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    try {
      const r = await this.client.files.uploadV2({
        channel_id: chat,
        file: Bun.file(filePath),
        title: opts?.caption || "",
      })
      return { success: r.ok, id: r.files?.[0]?.id }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}
