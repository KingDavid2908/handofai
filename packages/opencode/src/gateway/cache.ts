import path from "path"
import { mkdir, readdir, stat as fsStat, rm } from "fs/promises"
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
