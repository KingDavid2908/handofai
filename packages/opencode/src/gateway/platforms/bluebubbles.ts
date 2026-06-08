import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class BlueBubblesAdapter implements PlatformAdapter {
  id = "bluebubbles"
  private url: string
  private apiKey: string
  private h?: Handler
  private socket: any
  private running = false

  constructor(key: string, cfg: Record<string, any>) {
    this.url = (cfg.server_url || "").replace(/\/$/, "")
    this.apiKey = key
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
    const { io } = await import("socket.io-client")
    this.socket = io(this.url, {
      auth: { apiKey: this.apiKey },
      transports: ["websocket", "polling"],
    })

    this.socket.on("connect", () => {
      this.socket.emit("authenticate", { apiKey: this.apiKey })
    })

    this.socket.on("new-message", (data: any) => {
      h({
        text: data.text || data.body || "",
        platform: "bluebubbles",
        chat: data.chatGuid || data.handle || "",
        type: data.chatGuid ? "group" : "dm",
        user: data.sender,
        msgId: data.guid,
      })
    })

    this.socket.on("connect_error", () => {})
  }

  async stop() {
    this.running = false
    this.socket?.disconnect()
  }

  isRunning() { return this.running }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      const chunks = paginateChunks(chunkText(text, 4096))
      for (const chunk of chunks) {
        const r = await fetch(`${this.url}/api/v1/message/text`, {
          method: "POST",
          headers: { "Z-API-Key": this.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ chatGuid: chat, message: chunk }),
        })
        const d = await r.json() as any
        if (!d.data) return { success: false, error: d.error || `${r.status}` }
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendMedia(chat: string, filePath: string, _opts?: SendMediaOpts): Promise<SendResult> {
    try {
      const file = Bun.file(filePath)
      const arr = new Uint8Array(await file.arrayBuffer())
      const b64 = Buffer.from(arr).toString("base64")
      const r = await fetch(`${this.url}/api/v1/message/attachment`, {
        method: "POST",
        headers: { "Z-API-Key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ chatGuid: chat, data: b64, name: filePath.split("/").pop() || "file" }),
      })
      const d = await r.json() as any
      if (d.data) return { success: true, id: String(d.data.guid) }
      return { success: false, error: d.error || `${r.status}` }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendImage(chat: string, filePath: string, _caption?: string): Promise<SendResult> {
    return this.sendMedia(chat, filePath)
  }

  async sendVideo(chat: string, filePath: string, _caption?: string): Promise<SendResult> {
    return this.sendMedia(chat, filePath)
  }

  async sendVoice(chat: string, filePath: string): Promise<SendResult> {
    return this.sendMedia(chat, filePath)
  }

  async sendDocument(chat: string, filePath: string, _filename?: string): Promise<SendResult> {
    return this.sendMedia(chat, filePath)
  }
}
