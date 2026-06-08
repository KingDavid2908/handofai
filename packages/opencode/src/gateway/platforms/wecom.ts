import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class WeComAdapter implements PlatformAdapter {
  id = "wecom"
  private corpId: string
  private agentId: string
  private secret: string
  private token = ""
  private tokenExpiry = 0
  private h?: Handler
  private running = false

  constructor(s: string, cfg: Record<string, any>) {
    this.corpId = cfg.corp_id || ""
    this.agentId = cfg.agent_id || ""
    this.secret = s
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
  }

  async stop() { this.running = false }
  isRunning() { return this.running }

  private async ensureToken() {
    if (this.token && Date.now() < this.tokenExpiry) return this.token
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${this.secret}`)
    const d = await r.json() as any
    if (d.errcode === 0) {
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
        const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            touser: chat,
            msgtype: "text",
            agentid: this.agentId,
            text: { content: chunk },
          }),
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
      const file = Bun.file(filePath)
      const arr = new Uint8Array(await file.arrayBuffer())
      const b64 = Buffer.from(arr).toString("base64")
      const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser: chat,
          msgtype: "file",
          agentid: this.agentId,
          file: { media_id: b64 },
        }),
      })
      const d = await r.json() as any
      if (d.errcode === 0) return { success: true, id: d.msgid }
      return { success: false, error: d.errmsg || `Error ${d.errcode}` }
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
