import type { Handler, PlatformAdapter, SendMediaOpts, SendOpts, SendResult, MediaItem } from "../adapter"
import { chunkText, paginateChunks } from "../adapter"
import { cacheImageFromUrl, cacheAudio, cacheVideo, cacheDoc } from "../cache"
import path from "path"

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
              const item: MediaItem | undefined = cached ? { type: "photo", mime: "image/jpeg", url, path: cached, filename: "photo.jpg", caption: m.caption } : undefined
              this.h?.({
                text: m.caption || "",
                platform: "telegram",
                chat,
                type,
                user: m.from ? String(m.from.id) : undefined,
                msgId: String(m.message_id),
                media: item ? [item] : undefined,
              })
            }
          }

          if (m.document) {
            const doc = m.document
            const fid = doc.file_id
            const fdata = await this.call("getFile", { file_id: fid })
            if (fdata.result?.file_path) {
              const url = `https://api.telegram.org/file/bot${this.token}/${fdata.result.file_path}`
              const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
              if (r.ok) {
                const buf = new Uint8Array(await r.arrayBuffer())
                const cached = await cacheDoc(buf, doc.file_name || "file")
                const mime = doc.mime_type || "application/octet-stream"
                const isImage = mime.startsWith("image/")
                const isVideo = mime.startsWith("video/")
                const item: MediaItem = { type: isImage ? "photo" : isVideo ? "video" : "document", mime, url, path: cached, filename: doc.file_name, size: doc.file_size }
                this.h?.({
                  text: m.caption || "",
                  platform: "telegram",
                  chat,
                  type,
                  user: m.from ? String(m.from.id) : undefined,
                  msgId: String(m.message_id),
                  media: [item],
                })
              }
            }
          }

          if (m.voice || m.audio) {
            const src = (m.voice || m.audio)!
            const fid = src.file_id
            const fdata = await this.call("getFile", { file_id: fid })
            if (fdata.result?.file_path) {
              const url = `https://api.telegram.org/file/bot${this.token}/${fdata.result.file_path}`
              const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
              if (r.ok) {
                const buf = new Uint8Array(await r.arrayBuffer())
                const cached = await cacheAudio(buf, ".ogg")
                const mime = src.mime_type || "audio/ogg"
                const isVoice = !!m.voice
                const item: MediaItem = { type: isVoice ? "voice" : "audio", mime, url, path: cached, filename: isVoice ? "voice.ogg" : "audio.ogg" }
                this.h?.({
                  text: m.caption || "",
                  platform: "telegram",
                  chat,
                  type,
                  user: m.from ? String(m.from.id) : undefined,
                  msgId: String(m.message_id),
                  media: [item],
                })
              }
            }
          }

          if (m.video || m.video_note) {
            const src = (m.video || m.video_note)!
            const fid = src.file_id
            const fdata = await this.call("getFile", { file_id: fid })
            if (fdata.result?.file_path) {
              const url = `https://api.telegram.org/file/bot${this.token}/${fdata.result.file_path}`
              const r = await fetch(url, { signal: AbortSignal.timeout(120000) })
              if (r.ok) {
                const buf = new Uint8Array(await r.arrayBuffer())
                const cached = await cacheVideo(buf, ".mp4")
                const mime = src.mime_type || "video/mp4"
                const item: MediaItem = { type: "video", mime, url, path: cached, filename: "video.mp4", caption: m.caption }
                this.h?.({
                  text: m.caption || "",
                  platform: "telegram",
                  chat,
                  type,
                  user: m.from ? String(m.from.id) : undefined,
                  msgId: String(m.message_id),
                  media: [item],
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

  async sendMedia(chat: string, filePath: string, opts?: SendMediaOpts): Promise<SendResult> {
    const file = Bun.file(filePath)
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

  async sendImage(chat: string, filePath: string, caption?: string): Promise<SendResult> {
    const form = new FormData()
    form.append("chat_id", chat)
    form.append("photo", Bun.file(filePath))
    if (caption) form.append("caption", caption)
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, {
      method: "POST", body: form,
    })
    const data = await r.json()
    if (!data.ok) return { success: false, error: data.description }
    return { success: true, id: String(data.result?.message_id) }
  }

  async sendVideo(chat: string, filePath: string, caption?: string): Promise<SendResult> {
    const form = new FormData()
    form.append("chat_id", chat)
    form.append("video", Bun.file(filePath))
    if (caption) form.append("caption", caption)
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendVideo`, {
      method: "POST", body: form,
    })
    const data = await r.json()
    if (!data.ok) return { success: false, error: data.description }
    return { success: true, id: String(data.result?.message_id) }
  }

  async sendVoice(chat: string, filePath: string): Promise<SendResult> {
    const form = new FormData()
    form.append("chat_id", chat)
    form.append("voice", Bun.file(filePath))
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendVoice`, {
      method: "POST", body: form,
    })
    const data = await r.json()
    if (!data.ok) return { success: false, error: data.description }
    return { success: true, id: String(data.result?.message_id) }
  }

  async sendDocument(chat: string, filePath: string, filename?: string): Promise<SendResult> {
    const form = new FormData()
    form.append("chat_id", chat)
    form.append("document", Bun.file(filePath))
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, {
      method: "POST", body: form,
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
