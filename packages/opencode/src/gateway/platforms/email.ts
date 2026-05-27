import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class EmailAdapter implements PlatformAdapter {
  id = "email"
  private host: string
  private port: number
  private user: string
  private password: string
  private imapHost: string
  private h?: Handler
  private running = false
  private timer?: ReturnType<typeof setInterval>
  private transport: any

  constructor(pwd: string, cfg: Record<string, any>) {
    this.host = cfg.smtp_host || "smtp.gmail.com"
    this.port = parseInt(cfg.smtp_port || "587", 10)
    this.user = cfg.username || ""
    this.password = pwd
    this.imapHost = cfg.imap_host || this.host
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
    const nodemailer = await import("nodemailer")
    this.transport = nodemailer.createTransport({
      host: this.host,
      port: this.port,
      secure: this.port === 465,
      auth: { user: this.user, pass: this.password },
    })
  }

  async stop() {
    this.running = false
    if (this.timer) clearInterval(this.timer)
  }

  isRunning() { return this.running }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      if (!this.transport) return { success: false, error: "not started" }
      const chunks = paginateChunks(chunkText(text, 100000))
      for (const chunk of chunks) {
        const info = await this.transport.sendMail({
          from: this.user,
          to: chat,
          subject: chunk.slice(0, 78),
          text: chunk,
        })
        if (!info.messageId) return { success: false, error: "send failed" }
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    try {
      if (!this.transport) return { success: false, error: "not started" }
      const info = await this.transport.sendMail({
        from: this.user,
        to: chat,
        subject: (opts?.caption || "Attachment").slice(0, 78),
        text: opts?.caption || "",
        attachments: [{ path: filePath }],
      })
      return { success: true, id: info.messageId }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}
