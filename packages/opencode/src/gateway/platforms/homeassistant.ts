import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class HomeAssistantAdapter implements PlatformAdapter {
  id = "homeassistant"
  private url: string
  private token: string
  private h?: Handler
  private running = false

  constructor(t: string, cfg: Record<string, any>) {
    this.url = (cfg.server_url || "").replace(/\/$/, "")
    this.token = t
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
  }

  async stop() { this.running = false }
  isRunning() { return this.running }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      const chunks = paginateChunks(chunkText(text, 4096))
      for (const chunk of chunks) {
        const r = await fetch(`${this.url}/api/services/notify/notify`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message: chunk, title: "HandOfAI" }),
        })
        if (!r.ok) return { success: false, error: `${r.status}` }
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    try {
      const file = Bun.file(filePath)
      const arr = new Uint8Array(await file.arrayBuffer())
      const b64 = Buffer.from(arr).toString("base64")
      const r = await fetch(`${this.url}/api/services/camera/snapshot`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ entity_id: chat, filename: filePath }),
      })
      if (r.ok) return { success: true }
      return { success: false, error: `${r.status}` }
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
