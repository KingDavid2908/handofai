import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"
import WebSocket from "ws"

export class MattermostAdapter implements PlatformAdapter {
  id = "mattermost"
  private url: string
  private token: string
  private h?: Handler
  private running = false
  private ws?: WebSocket
  private userId = ""

  constructor(t: string, cfg: Record<string, any>) {
    this.url = (cfg.server_url || "").replace(/\/$/, "")
    this.token = t
  }

  async start(h: Handler) {
    this.h = h
    this.running = true

    const me = await fetch(`${this.url}/api/v4/users/me`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (me.ok) {
      const u = await me.json() as any
      this.userId = u.id
    }

    this.connect()
  }

  private connect() {
    if (!this.running) return
    this.ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/api/v4/websocket`)

    this.ws.on("open", () => {
      this.ws?.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: this.token } }))
    })

    this.ws.on("message", (raw) => {
      try {
        const evt = JSON.parse(raw.toString())
        if (evt.event === "posted" && evt.data?.post) {
          const post = evt.data.post
          if (post.user_id === this.userId) return
          const channelId = evt.data.channel_id || evt.broadcast?.channel_id || ""
          this.h?.({
            text: post.message || "",
            platform: "mattermost",
            chat: channelId,
            type: "group",
            user: post.user_id,
            msgId: post.id,
          })
        }
      } catch {}
    })

    this.ws.on("close", () => {
      if (this.running) setTimeout(() => this.connect(), 3000)
    })
  }

  async stop() {
    this.running = false
    this.ws?.close()
  }

  isRunning() { return this.running }

  async sendTyping(chat: string) {
    this.ws?.send(JSON.stringify({
      action: "user_typing",
      data: { channel_id: chat },
      seq: Date.now(),
    }))
  }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      const chunks = paginateChunks(chunkText(text, 16383))
      for (const chunk of chunks) {
        const r = await fetch(`${this.url}/api/v4/posts`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ channel_id: chat, message: chunk }),
        })
        const d = await r.json() as any
        if (!d.id) return { success: false, error: d.message || `${r.status}` }
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    try {
      const form = new FormData()
      form.append("channel_id", chat)
      form.append("files", Bun.file(filePath))
      if (opts?.caption) form.append("message", opts.caption)
      const r = await fetch(`${this.url}/api/v4/posts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
        body: form,
      })
      const d = await r.json() as any
      if (d.id) return { success: true, id: d.id }
      return { success: false, error: d.message || `${r.status}` }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendImage(chat: string, filePath: string, caption?: string): Promise<SendResult> {
    return this.sendMedia(chat, filePath, { caption })
  }

  async sendVideo(chat: string, filePath: string, caption?: string): Promise<SendResult> {
    return this.sendMedia(chat, filePath, { caption })
  }

  async sendVoice(chat: string, filePath: string): Promise<SendResult> {
    return this.sendMedia(chat, filePath)
  }

  async sendDocument(chat: string, filePath: string, filename?: string): Promise<SendResult> {
    return this.sendMedia(chat, filePath)
  }
}
