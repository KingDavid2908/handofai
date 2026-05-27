import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class MatrixAdapter implements PlatformAdapter {
  id = "matrix"
  private homeserver: string
  private token: string
  private h?: Handler
  private running = false
  private since = ""
  private timer?: ReturnType<typeof setTimeout>

  constructor(token: string, cfg: Record<string, any>) {
    this.homeserver = (cfg.homeserver_url || "https://matrix.org").replace(/\/$/, "")
    this.token = token
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
    this.poll()
  }

  private poll() {
    if (!this.running) return
    const url = `${this.homeserver}/_matrix/client/v3/sync?timeout=30000${this.since ? `&since=${this.since}` : ""}`
    this.timer = setTimeout(async () => {
      try {
        const r = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(35000),
        })
        const data = await r.json() as any
        this.since = data.next_batch || this.since
        const rooms = data.rooms?.join || {}
        for (const [roomId, room] of Object.entries(rooms)) {
          const timeline = (room as any).timeline?.events || []
          for (const evt of timeline) {
            if (evt.type !== "m.room.message" || evt.sender === (data.account_data?.events?.[0]?.user_id)) continue
            const content = evt.content
            if (content?.msgtype === "m.text") {
              this.h?.({
                text: content.body || "",
                platform: "matrix",
                chat: roomId,
                type: "group",
                user: evt.sender,
                msgId: evt.event_id,
              })
            }
          }
        }
      } catch {}
      this.poll()
    }, 100)
  }

  async stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
  }

  isRunning() { return this.running }

  async sendTyping(chat: string) {
    await fetch(`${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(chat)}/typing`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ typing: true, timeout: 30000 }),
    })
  }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      const chunks = paginateChunks(chunkText(text, 65535))
      for (const chunk of chunks) {
        const txn = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        const r = await fetch(`${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(chat)}/send/m.room.message/${txn}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ msgtype: "m.text", body: chunk }),
        })
        const d = await r.json() as any
        if (!d.event_id) return { success: false, error: d.error || `${r.status}` }
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    try {
      const file = Bun.file(filePath)
      const mime = file.type || "application/octet-stream"
      const r = await fetch(`${this.homeserver}/_matrix/media/v3/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": mime },
        body: file,
      })
      const d = await r.json() as any
      if (!d.content_uri) return { success: false, error: "upload failed" }
      const txn = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      const r2 = await fetch(`${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(chat)}/send/m.room.message/${txn}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          msgtype: mime.startsWith("image/") ? "m.image" : mime.startsWith("video/") ? "m.video" : "m.file",
          body: opts?.caption || "file",
          url: d.content_uri,
        }),
      })
      const d2 = await r2.json() as any
      if (d2.event_id) return { success: true, id: d2.event_id }
      return { success: false, error: d2.error || `${r2.status}` }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}
