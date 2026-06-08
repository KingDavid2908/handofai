import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class SmsAdapter implements PlatformAdapter {
  id = "sms"
  private sid: string
  private token: string
  private from: string
  private h?: Handler
  private running = false
  private aborter?: AbortController

  constructor(key: string, cfg: Record<string, any>) {
    const [s, t] = key.split(":")
    this.sid = s
    this.token = t || ""
    this.from = cfg.from || ""
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
  }

  async stop() {
    this.running = false
    this.aborter?.abort()
  }

  isRunning() { return this.running }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      const chunks = paginateChunks(chunkText(text, 1600))
      for (const chunk of chunks) {
        const params = new URLSearchParams({
          To: chat,
          From: this.from,
          Body: chunk,
        })
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, {
          method: "POST",
          headers: {
            Authorization: "Basic " + Buffer.from(`${this.sid}:${this.token}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        })
        const d = await r.json() as any
        if (!d.sid) return { success: false, error: d.message || `${r.status}` }
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    try {
      const params = new URLSearchParams({
        To: chat,
        From: this.from,
        Body: (opts?.caption || "").slice(0, 1600),
        MediaUrl: filePath,
      })
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${this.sid}:${this.token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      })
      const d = await r.json() as any
      if (d.sid) return { success: true, id: d.sid }
      return { success: false, error: d.message || `${r.status}` }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendImage(chat: string, filePath: string, caption?: string): Promise<SendResult> {
    return { success: false, error: "SMS does not support media" }
  }

  async sendVideo(chat: string, filePath: string, caption?: string): Promise<SendResult> {
    return { success: false, error: "SMS does not support media" }
  }

  async sendVoice(chat: string, filePath: string): Promise<SendResult> {
    return { success: false, error: "SMS does not support media" }
  }

  async sendDocument(chat: string, filePath: string, filename?: string): Promise<SendResult> {
    return { success: false, error: "SMS does not support media" }
  }
}
