import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class WebhookAdapter implements PlatformAdapter {
  id = "webhook"
  private urls: string[] = []
  private h?: Handler
  private running = false

  constructor(secret: string, cfg: Record<string, any>) {
    if (cfg.incoming_urls) {
      this.urls = Array.isArray(cfg.incoming_urls) ? cfg.incoming_urls : [cfg.incoming_urls]
    } else if (cfg.url) {
      this.urls = [cfg.url]
    }
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
  }

  async stop() { this.running = false }
  isRunning() { return this.running }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    if (this.urls.length === 0) return { success: false, error: "no webhook URLs configured" }
    let last: SendResult = { success: false, error: "no URLs" }
    for (const url of this.urls) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, chat_id: chat, platform: "webhook" }),
        })
        if (r.ok) return { success: true }
        last = { success: false, error: `${r.status}` }
      } catch (e: any) {
        last = { success: false, error: e.message }
      }
    }
    return last
  }

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    if (this.urls.length === 0) return { success: false, error: "no webhook URLs configured" }
    let last: SendResult = { success: false, error: "no URLs" }
    for (const url of this.urls) {
      try {
        const form = new FormData()
        form.append("file", Bun.file(filePath))
        form.append("chat_id", chat)
        if (opts?.caption) form.append("text", opts.caption)
        const r = await fetch(url, { method: "POST", body: form })
        if (r.ok) return { success: true }
        last = { success: false, error: `${r.status}` }
      } catch (e: any) {
        last = { success: false, error: e.message }
      }
    }
    return last
  }
}
