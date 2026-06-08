import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class WhatsAppBusinessAdapter implements PlatformAdapter {
  id = "whatsapp_business"
  private token: string
  private phoneId: string
  private h?: Handler
  private running = false
  private version = "v22.0"

  constructor(token: string, cfg: Record<string, any>) {
    this.token = token
    this.phoneId = cfg.phone_number_id || ""
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
        const r = await fetch(`https://graph.facebook.com/${this.version}/${this.phoneId}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: chat,
            type: "text",
            text: { body: chunk },
          }),
        })
        const d = await r.json() as any
        if (!d.messages?.[0]) return { success: false, error: d.error?.message || `${r.status}` }
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    try {
      const form = new FormData()
      form.append("messaging_product", "whatsapp")
      form.append("to", chat)
      form.append("type", "image")
      form.append("image", Bun.file(filePath))
      if (opts?.caption) form.append("image.caption", opts.caption)

      const r = await fetch(`https://graph.facebook.com/${this.version}/${this.phoneId}/media`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
        body: form,
      })
      const d = await r.json() as any
      if (d.id) return { success: true, id: d.id }
      return { success: false, error: d.error?.message || `${r.status}` }
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
