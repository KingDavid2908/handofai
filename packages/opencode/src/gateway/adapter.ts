export interface SendOpts {
  media?: { url: string; type: string }
  reply?: string
}

export interface SendMediaOpts {
  caption?: string
  type?: string
}

export interface SendResult {
  success: boolean
  id?: string
  error?: string
}

export type MediaType = "photo" | "video" | "audio" | "voice" | "document" | "sticker"

export interface MediaItem {
  type: MediaType
  mime: string
  url?: string
  path?: string
  filename?: string
  size?: number
  caption?: string
}

export interface Msg {
  text: string
  platform: string
  chat: string
  type: "dm" | "group" | "channel"
  user?: string
  msgId?: string
  media?: MediaItem[]
  reply?: string
  replyText?: string
}

export type Handler = (msg: Msg) => void

export interface PlatformAdapter {
  id: string
  start(handler: Handler): Promise<void>
  stop(): Promise<void>
  send(chat: string, text: string, opts?: SendOpts): Promise<SendResult>
  sendMedia(chat: string, path: string, opts?: SendMediaOpts): Promise<SendResult>
  isRunning(): boolean
  sendTyping?(chat: string): Promise<void>
  sendImage?(chat: string, path: string, caption?: string): Promise<SendResult>
  sendVideo?(chat: string, path: string, caption?: string): Promise<SendResult>
  sendVoice?(chat: string, path: string): Promise<SendResult>
  sendDocument?(chat: string, path: string, filename?: string): Promise<SendResult>
  sendAlbum?(chat: string, paths: string[], caption?: string): Promise<SendResult>
}

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let idx = remaining.lastIndexOf("\n\n", limit)
    if (idx < limit * 0.5) idx = remaining.lastIndexOf("\n", limit)
    if (idx < limit * 0.75) idx = remaining.lastIndexOf(" ", limit)
    if (idx <= 0) idx = limit
    chunks.push(remaining.slice(0, idx))
    remaining = remaining.slice(idx).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export function paginateChunks(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks
  return chunks.map((c, i) => `(${i + 1}/${chunks.length}) ${c}`)
}

export function toWhatsAppFormat(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "*$1*")
    .replace(/~~(.*?)~~/g, "~$1~")
    .replace(/^#+\s+(.*)$/gm, "*$1*")
}
