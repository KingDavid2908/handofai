import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class QqBotAdapter implements PlatformAdapter {
  id = "qqbot"
  private appId: string
  private token: string
  private h?: Handler
  private running = false

  constructor(t: string, cfg: Record<string, any>) {
    this.appId = cfg.app_id || ""
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
        const r = await fetch(`https://api.sgroup.qq.com/v2/users/${chat}/messages`, {
          method: "POST",
          headers: {
            Authorization: `QQBot ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: chunk, msg_type: 0 }),
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
      const file = Bun.file(filePath)
      const arr = new Uint8Array(await file.arrayBuffer())
      const b64 = Buffer.from(arr).toString("base64")
      const r = await fetch(`https://api.sgroup.qq.com/v2/users/${chat}/files`, {
        method: "POST",
        headers: {
          Authorization: `QQBot ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_type: 1, file_data: b64, srv_send_msg: true }),
      })
      const d = await r.json() as any
      if (d.file_uuid) return { success: true, id: d.file_uuid }
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
