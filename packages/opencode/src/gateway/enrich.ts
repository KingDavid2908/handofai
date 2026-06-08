import type { Msg, MediaItem } from "./adapter"
import path from "path"
import { existsSync } from "fs"

export async function enrichMessageWithMedia(msg: Msg): Promise<{ text: string; attach: MediaItem[] }> {
  let text = msg.text
  const attach: MediaItem[] = []

  if (!msg.media?.length) return { text, attach }

  const { readTextContent } = await import("./cache")

  for (const item of msg.media) {
    const p = item.path || item.url
    switch (item.type) {
      case "photo":
        if (p) attach.push(item)
        if (!text) text = `[The user sent an image]`
        break
      case "voice":
        text = `[The user sent a voice message]\n\n${text}`
        if (p) attach.push(item)
        break
      case "video":
        text = `[The user sent a video: ${item.filename || "video"}]\n\n${text}`
        if (p) attach.push(item)
        break
      case "audio":
        text = `[The user sent an audio file: ${item.filename || "audio"}]\n\n${text}`
        if (p) attach.push(item)
        break
      case "document":
        if (p) {
          const content = readTextContent(p)
          if (content) {
            text = `${content}\n\n${text}`
          } else {
            text = `[The user sent a document: ${item.filename || "document"}]\n\n${text}`
            attach.push(item)
          }
        } else {
          text = `[The user sent a document: ${item.filename || "document"}]\n\n${text}`
        }
        break
      case "sticker":
        text = `[The user sent a sticker]\n\n${text}`
        if (p) attach.push(item)
        break
    }
  }
  return { text, attach }
}

export function extractMediaDirectives(text: string): { paths: { path: string; asDoc: boolean; asVoice: boolean }[]; text: string } {
  const paths: { path: string; asDoc: boolean; asVoice: boolean }[] = []
  let cleaned = text

  const re = /MEDIA:\s*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\/[^\s\n]+|\~\/[^\s\n]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const raw = match[1].replace(/^[`"']|[`"']$/g, "")
    const before = text.slice(Math.max(0, match.index - 50), match.index)
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 50)
    const ctx = before + after
    paths.push({
      path: raw,
      asDoc: ctx.includes("[[as_document]]"),
      asVoice: ctx.includes("[[audio_as_voice]]"),
    })
    cleaned = cleaned.replace(match[0], "")
  }
  cleaned = cleaned.replace(/\[\[audio_as_voice\]\]/g, "")
  cleaned = cleaned.replace(/\[\[as_document\]\]/g, "")

  return { paths, text: cleaned }
}

export function extractMarkdownImages(text: string): { urls: string[]; text: string } {
  const urls: string[] = []
  let cleaned = text
  const mdRe = /!\[[^\]]*\]\(([^)]+)\)/g
  let match: RegExpExecArray | null
  while ((match = mdRe.exec(text)) !== null) {
    urls.push(match[1])
    cleaned = cleaned.replace(match[0], "")
  }
  const htmlRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
  while ((match = htmlRe.exec(text)) !== null) {
    urls.push(match[1])
  }
  return { urls, text: cleaned }
}

export function extractLocalFilePaths(text: string): string[] {
  const extensions = [
    "png", "jpe?g", "gif", "webp", "bmp", "tiff", "svg",
    "mp4", "mov", "avi", "mkv", "webm", "3gp",
    "ogg", "opus", "mp3", "wav", "m4a", "flac",
    "pdf", "docx?", "xlsx?", "pptx?",
    "zip", "rar", "7z", "tar", "gz", "epub",
    "csv", "json", "yaml", "yml", "xml", "txt", "md",
  ].join("|")
  const re = new RegExp(`(\\/[^\\s\\n]+\\.(?:${extensions}))`, "gi")
  const seen = new Set<string>()
  const paths: string[] = []
  const { validateMediaPath } = require("./cache")

  for (const m of text.matchAll(re)) {
    const p = m[1]
    const before = text.slice(0, m.index!)
    const backtickCount = (before.match(/```/g) || []).length
    if (backtickCount % 2 !== 0) continue
    if (seen.has(p)) continue
    seen.add(p)
    if (existsSync(p) && validateMediaPath(p)) {
      paths.push(p)
    }
  }
  return paths
}

export async function deliverMediaFromResponse(text: string, chat: string, eng: any, platform: string): Promise<string> {
  const adapter = eng.adapters?.get(platform)
  const { cacheImageFromUrl, validateMediaPath, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS } = await import("./cache")
  let cleaned = text

  // MEDIA: directives
  const { paths, text: t1 } = extractMediaDirectives(cleaned)
  cleaned = t1

  for (const { path: fp, asDoc, asVoice } of paths) {
    if (!validateMediaPath(fp)) continue
    const ext = path.extname(fp).toLowerCase()

    if (asDoc) {
      await adapter?.sendDocument?.(chat, fp, path.basename(fp)).catch(() => {})
    } else if (asVoice) {
      await adapter?.sendVoice?.(chat, fp).catch(() => {})
    } else if (IMAGE_EXTS.has(ext)) {
      await adapter?.sendImage?.(chat, fp).catch(() => {})
    } else if (VIDEO_EXTS.has(ext)) {
      await adapter?.sendVideo?.(chat, fp).catch(() => {})
    } else if (AUDIO_EXTS.has(ext)) {
      await adapter?.sendVoice?.(chat, fp).catch(() => {})
    } else {
      await adapter?.sendDocument?.(chat, fp, path.basename(fp)).catch(() => {})
    }
  }

  // Markdown images
  const { urls, text: t2 } = extractMarkdownImages(cleaned)
  cleaned = t2
  for (const url of urls) {
    try {
      const local = await cacheImageFromUrl(url)
      if (validateMediaPath(local)) {
        await adapter?.sendImage?.(chat, local).catch(() => {})
      }
    } catch {}
  }

  // Bare file paths (don't strip from text, just deliver)
  const locals = extractLocalFilePaths(cleaned)
  for (const fp of locals) {
    const ext = path.extname(fp).toLowerCase()
    if (IMAGE_EXTS.has(ext)) {
      await adapter?.sendImage?.(chat, fp).catch(() => {})
    } else if (VIDEO_EXTS.has(ext)) {
      await adapter?.sendVideo?.(chat, fp).catch(() => {})
    } else {
      await adapter?.sendDocument?.(chat, fp, path.basename(fp)).catch(() => {})
    }
  }

  return cleaned
}
