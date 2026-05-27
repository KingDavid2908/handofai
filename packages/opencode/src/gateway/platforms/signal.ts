import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class SignalAdapter implements PlatformAdapter {
  id = "signal"
  private url: string
  private account: string
  private h?: Handler
  private running = false
  private controller?: AbortController

  constructor(_phone: string, cfg: Record<string, any>) {
    this.url = (cfg.cli_url || "http://127.0.0.1:8080").replace(/\/$/, "")
    this.account = cfg.phone || ""
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
    this.controller = new AbortController()

    this.poll()
  }

  private async poll() {
    while (this.running) {
      try {
        const r = await fetch(`${this.url}/v1/receive/${this.account}`, {
          signal: this.controller?.signal,
        })
        if (!r.ok) { await new Promise((r) => setTimeout(r, 5000)); continue }
        const data = await r.text()
        if (data.trim()) {
          const lines = data.split("\n").filter(Boolean)
          for (const line of lines) {
            try {
              const msg = JSON.parse(line)
              if (msg.envelope?.dataMessage) {
                this.h?.({
                  text: msg.envelope.dataMessage.message || "",
                  platform: "signal",
                  chat: msg.envelope.source,
                  type: "dm",
                  msgId: String(msg.envelope.timestamp),
                })
              }
            } catch {}
          }
        }
      } catch {
        if (this.running) await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }

  async stop() {
    this.running = false
    this.controller?.abort()
  }

  isRunning() { return this.running }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      const chunks = paginateChunks(chunkText(text, 4096))
      for (const chunk of chunks) {
        const r = await fetch(`${this.url}/v2/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            account: this.account,
            recipients: [chat],
            message: chunk,
          }),
        })
        const d = await r.json() as any
        if (!d.timestamp) return { success: false, error: d.error || `${r.status}` }
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
      const r = await fetch(`${this.url}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: this.account,
          recipients: [chat],
          message: opts?.caption || "",
          base64_attachments: [b64],
        }),
      })
      const d = await r.json() as any
      if (d.timestamp) return { success: true, id: String(d.timestamp) }
      return { success: false, error: d.error || `${r.status}` }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}
