import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"

export class FeishuAdapter implements PlatformAdapter {
  id = "feishu"
  private appId: string
  private appSecret: string
  private token = ""
  private tokenExpiry = 0
  private h?: Handler
  private running = false

  constructor(secret: string, cfg: Record<string, any>) {
    this.appId = cfg.app_id || ""
    this.appSecret = secret
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
  }

  async stop() { this.running = false }
  isRunning() { return this.running }

  private async ensureToken() {
    if (this.token && Date.now() < this.tokenExpiry) return this.token
    const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    })
    const d = await r.json() as any
    if (d.tenant_access_token) {
      this.token = d.tenant_access_token
      this.tokenExpiry = Date.now() + (d.expire || 7200) * 1000 - 60000
      return this.token
    }
    throw new Error(d.msg || "Failed to get token")
  }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    try {
      const token = await this.ensureToken()
      const chunks = paginateChunks(chunkText(text, 4096))
      for (const chunk of chunks) {
        const r = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            receive_id: chat,
            msg_type: "text",
            content: JSON.stringify({ text: chunk }),
          }),
        })
        const d = await r.json() as any
        if (d.code !== 0) return { success: false, error: d.msg || `Error ${d.code}` }
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
      const ext = filePath.split(".").pop() || "bin"
      const form = new FormData()
      form.append("file_type", "stream")
      form.append("file_name", filePath.split("/").pop() || "file")
      form.append("file", file)
      const up = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      const upData = await up.json() as any
      if (upData.code !== 0) return { success: false, error: upData.msg }
      const r = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: chat,
          msg_type: "file",
          content: JSON.stringify({ file_key: upData.data?.file_key }),
        }),
      })
      const d = await r.json() as any
      if (d.code === 0) return { success: true, id: d.data?.message_id }
      return { success: false, error: d.msg || `Error ${d.code}` }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}
