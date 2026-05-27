import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"
import { cacheImageFromUrl, cacheAudio, cacheVideo, cacheDoc } from "../cache"

export class TelegramAdapter implements PlatformAdapter {
  id = "telegram"
  private token: string
  private h?: Handler
  private running = false
  private offset = 0
  private timer?: ReturnType<typeof setTimeout>

  constructor(token: string) {
    this.token = token
  }

  async start(h: Handler) {
    this.h = h
    this.running = true
    try {
      const init = await this.call("getUpdates", { offset: 0, timeout: 1, limit: 1 })
      if (init.result?.length) {
        this.offset = init.result[init.result.length - 1].update_id + 1
      }
    } catch {}
    this.poll()
  }

  private poll() {
    if (!this.running) return
    this.timer = setTimeout(async () => {
      try {
        const { result } = await this.call("getUpdates", { offset: this.offset, timeout: 30 })
        for (const u of result || []) {
          this.offset = u.update_id + 1
          const m = u.message || u.edited_message
          if (!m) continue
          const chat = String(m.chat.id)
          const type = m.chat.type === "private" ? "dm" as const : "group" as const

          if (m.text) {
            this.h?.({
              text: m.text,
              platform: "telegram",
              chat,
              type,
              user: m.from ? String(m.from.id) : undefined,
              msgId: String(m.message_id),
            })
          }

          if (m.photo) {
            const best = m.photo[m.photo.length - 1]
            const fid = best.file_id
            const fdata = await this.call("getFile", { file_id: fid })
            if (fdata.result?.file_path) {
              const url = `https://api.telegram.org/file/bot${this.token}/${fdata.result.file_path}`
              const cached = await cacheImageFromUrl(url).catch(() => undefined)
              this.h?.({
                text: m.caption || "",
                platform: "telegram",
                chat,
                type,
                user: m.from ? String(m.from.id) : undefined,
                msgId: String(m.message_id),
                media: cached ? [{ url: cached, type: "image" }] : undefined,
              })
            }
          }

          if (m.document) {
            const fid = m.document.file_id
            const fdata = await this.call("getFile", { file_id: fid })
            if (fdata.result?.file_path) {
              const url = `https://api.telegram.org/file/bot${this.token}/${fdata.result.file_path}`
              const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
              if (r.ok) {
                const buf = new Uint8Array(await r.arrayBuffer())
                const cached = await cacheDoc(buf, m.document.file_name || "file")
                this.h?.({
                  text: m.caption || "",
                  platform: "telegram",
                  chat,
                  type,
                  user: m.from ? String(m.from.id) : undefined,
                  msgId: String(m.message_id),
                  media: [{ url: cached, type: "document" }],
                })
              }
            }
          }

          if (m.voice || m.audio) {
            const fid = (m.voice || m.audio)!.file_id
            const fdata = await this.call("getFile", { file_id: fid })
            if (fdata.result?.file_path) {
              const url = `https://api.telegram.org/file/bot${this.token}/${fdata.result.file_path}`
              const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
              if (r.ok) {
                const buf = new Uint8Array(await r.arrayBuffer())
                const cached = await cacheAudio(buf, ".ogg")
                this.h?.({
                  text: m.caption || "",
                  platform: "telegram",
                  chat,
                  type,
                  user: m.from ? String(m.from.id) : undefined,
                  msgId: String(m.message_id),
                  media: [{ url: cached, type: "audio" }],
                })
              }
            }
          }

          if (m.video || m.video_note) {
            const fid = (m.video || m.video_note)!.file_id
            const fdata = await this.call("getFile", { file_id: fid })
            if (fdata.result?.file_path) {
              const url = `https://api.telegram.org/file/bot${this.token}/${fdata.result.file_path}`
              const r = await fetch(url, { signal: AbortSignal.timeout(120000) })
              if (r.ok) {
                const buf = new Uint8Array(await r.arrayBuffer())
                const cached = await cacheVideo(buf, ".mp4")
                this.h?.({
                  text: m.caption || "",
                  platform: "telegram",
                  chat,
                  type,
                  user: m.from ? String(m.from.id) : undefined,
                  msgId: String(m.message_id),
                  media: [{ url: cached, type: "video" }],
                })
              }
            }
          }
        }
      } catch {}
      this.poll()
    }, 100)
  }

  async stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
  }

  isRunning() { return this.running }

  async sendTyping(chat: string) {
    await this.call("sendChatAction", { chat_id: chat, action: "typing" })
  }

  async send(chat: string, text: string, _opts?: SendOpts): Promise<SendResult> {
    const chunks = paginateChunks(chunkText(text, 4096))
    for (const chunk of chunks) {
      const r = await this.call("sendMessage", {
        chat_id: chat,
        text: chunk,
        parse_mode: "HTML",
      })
      if (!r.ok) return { success: false, error: r.description }
    }
    return { success: true }
  }

  async sendMedia(chat: string, path: string, opts?: SendMediaOpts): Promise<SendResult> {
    const file = Bun.file(path)
    const form = new FormData()
    form.append("chat_id", chat)
    form.append("document", file)
    if (opts?.caption) form.append("caption", opts.caption)
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, {
      method: "POST",
      body: form,
    })
    const data = await r.json()
    if (!data.ok) return { success: false, error: data.description }
    return { success: true, id: String(data.result?.message_id) }
  }

  private async call(method: string, params: Record<string, any>) {
    const url = `https://api.telegram.org/bot${this.token}/${method}`
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: method === "getUpdates" ? AbortSignal.timeout(35000) : undefined,
    })
    return r.json()
  }
}
