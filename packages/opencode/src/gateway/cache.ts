import path from "path"
import { mkdir, readdir, stat as fsStat, rm } from "fs/promises"
import { readFileSync, existsSync, statSync } from "fs"
import { Global } from "../global"

const base = path.join(Global.Path.state, "gateway", "cache")

const dirs = {
  image: path.join(base, "images"),
  audio: path.join(base, "audio"),
  video: path.join(base, "videos"),
  doc: path.join(base, "documents"),
}

async function ensure(dir: string) {
  await mkdir(dir, { recursive: true }).catch(() => {})
}

function rid() {
  return Math.random().toString(36).slice(2, 14)
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
}

const IMAGE_MAGIC: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], ".png"],
  [[0xff, 0xd8, 0xff], ".jpg"],
  [[0x47, 0x49, 0x46], ".gif"],
  [[0x52, 0x49, 0x46, 0x46], ".webp"],
  [[0x42, 0x4d], ".bmp"],
]

function detectExt(data: Uint8Array): string {
  for (const [magic, ext] of IMAGE_MAGIC) {
    if (magic.every((b, i) => data[i] === b)) return ext
  }
  return ".jpg"
}

export async function cacheImage(data: Uint8Array, ext?: string): Promise<string> {
  await ensure(dirs.image)
  const e = ext ?? detectExt(data)
  const file = path.join(dirs.image, `img_${rid()}${e}`)
  await Bun.write(file, data)
  return file
}

export async function cacheImageFromUrl(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { "User-Agent": "HandOfAI/1.0", Accept: "image/*,*/*;q=0.8" },
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`Failed to download image: ${r.status}`)
  const buf = new Uint8Array(await r.arrayBuffer())
  const ct = r.headers.get("content-type") || ""
  let ext = ".jpg"
  for (const [e, mime] of Object.entries(IMAGE_MIME)) {
    if (ct.includes(mime)) { ext = e; break }
  }
  return cacheImage(buf, ext)
}

export async function cacheAudio(data: Uint8Array, ext = ".ogg"): Promise<string> {
  await ensure(dirs.audio)
  const file = path.join(dirs.audio, `audio_${rid()}${ext}`)
  await Bun.write(file, data)
  return file
}

export async function cacheVideo(data: Uint8Array, ext = ".mp4"): Promise<string> {
  await ensure(dirs.video)
  const file = path.join(dirs.video, `video_${rid()}${ext}`)
  await Bun.write(file, data)
  return file
}

export async function cacheDoc(data: Uint8Array, name: string): Promise<string> {
  await ensure(dirs.doc)
  const safe = name.replace(/[<>:"/\\|?*\x00]/g, "_").slice(-80) || "doc"
  const file = path.join(dirs.doc, `doc_${rid()}_${safe}`)
  await Bun.write(file, data)
  return file
}

export async function cleanup(maxAgeHours = 24): Promise<number> {
  let removed = 0
  const cutoff = Date.now() - maxAgeHours * 3600000
  for (const d of Object.values(dirs)) {
    try {
      const entries = await readdir(d, { withFileTypes: true }).catch(() => [] as any[])
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue
        if (!entry.isFile()) continue
        const fpath = path.join(d, entry.name)
        try {
          const st = await fsStat(fpath)
          if (st.mtimeMs < cutoff) {
            await rm(fpath).catch(() => {})
            removed++
          }
        } catch {}
      }
    } catch {}
  }
  return removed
}

export const CACHE_PATHS = dirs

export const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".svg",
])

export const VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp",
])

export const AUDIO_EXTS = new Set([
  ".ogg", ".opus", ".mp3", ".wav", ".m4a", ".flac",
])

export const DOC_EXTS = new Set([
  ".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt", ".md",
  ".xlsx", ".xls", ".ods", ".csv", ".json", ".xml", ".yaml", ".yml",
  ".pptx", ".ppt", ".odp",
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".html", ".htm", ".epub",
])

export const MEDIA_EXTS: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".tiff": "image/tiff", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska", ".webm": "video/webm", ".3gp": "video/3gpp",
  ".ogg": "audio/ogg", ".opus": "audio/opus", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip", ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed", ".tar": "application/x-tar",
  ".gz": "application/gzip", ".epub": "application/epub+zip",
}

export const TEXT_INJECTABLE_EXTS = new Set([
  ".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".xml", ".toml",
  ".ini", ".cfg", ".log", ".ts", ".py", ".sh", ".js", ".html", ".css",
])

const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/,
  /^fd00:/,
]

export function isSafeUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (host === "localhost" || host === "metadata.google.internal") return false
    return true
  } catch {
    return false
  }
}

export function validateMediaPath(filepath: string): boolean {
  const resolved = path.resolve(filepath)
  return resolved.startsWith(base) && !resolved.includes("..")
}

export function readTextContent(filepath: string, maxBytes = 100_000): string | null {
  if (!existsSync(filepath)) return null
  const ext = path.extname(filepath).toLowerCase()
  if (!TEXT_INJECTABLE_EXTS.has(ext)) return null
  const st = statSync(filepath)
  if (st.size > maxBytes) return null
  const content = readFileSync(filepath, "utf-8")
  const name = path.basename(filepath)
  return `[Content of ${name}]:\n${content}`
}
