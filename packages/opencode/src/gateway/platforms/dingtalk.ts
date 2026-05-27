import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class DingTalkAdapter implements PlatformAdapter {
  id = "dingtalk"
  private appKey: string
  private appSecret: string
  private robotCode: string
  private token = ""
  private tokenExpiry = 0
  private h?: Handler
  private running = false

  constructor(secret: string, cfg: Record<string, any>) {
    this.appKey = cfg.app_id || ""
    this.appSecret = secret
    this.robotCode = cfg.robot_code || ""
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
  }

  async stop() { this.running = false }
  isRunning() { return this.running }

  private async ensureToken() {
    if (this.token && Date.now() < this.tokenExpiry) return this.token
    const r = await fetch("https://oapi.dingtalk.com/gettoken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey: this.appKey, appSecret: this.appSecret }),
    })
    const d = await r.json() as any
    if (d.access_token) {
      this.token = d.access_token
      this.tokenExpiry = Date.now() + (d.expires_in || 7200) * 1000 - 60000
      return this.token
    }
    throw new Error(d.errmsg || "Failed to get token")
  }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      const token = await this.ensureToken()
      const chunks = paginateChunks(chunkText(text, 4096))
      for (const chunk of chunks) {
        const r = await fetch(`https://oapi.dingtalk.com/robot/send?access_token=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ robotCode: this.robotCode, toUser: chat, msgKey: "sampleText", msgParam: JSON.stringify({ content: chunk }) }),
        })
        const d = await r.json() as any
        if (d.errcode !== 0) return { success: false, error: d.errmsg || `Error ${d.errcode}` }
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    try {
      const token = await this.ensureToken()
      const r = await fetch(`https://oapi.dingtalk.com/robot/send?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          robotCode: this.robotCode,
          toUser: chat,
          msgKey: "sampleMarkdown",
          msgParam: JSON.stringify({ title: opts?.caption || "Media", text: `File: ${filePath}\n\n${opts?.caption || ""}` }),
        }),
      })
      const d = await r.json() as any
      if (d.errcode === 0) return { success: true, id: d.processQueryKey }
      return { success: false, error: d.errmsg || `Error ${d.errcode}` }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}
