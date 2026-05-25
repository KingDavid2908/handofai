import { Global } from "@/global"
import { Log } from "@/util/log"
import { Filesystem } from "@/util/filesystem"
import path from "path"
import * as HfSpaces from "./hf-spaces"

const log = Log.create({ service: "media.registry" })
const REGISTRY_FILE = path.join(Global.Path.state, "media-registry.json")

interface SpaceEntry {
  id: string
  likes: number
  source: "builtin" | "fetched" | "user"
  note?: string
}

interface Category {
  spaces: SpaceEntry[]
  userAdded: boolean
}

interface Registry {
  version: number
  settings: {
    updateMode: "manual" | "auto"
    intervalDays: number
    lastUpdated: string
  }
  categories: Record<string, Category>
}

const DEFAULT_REGISTRY: Registry = {
  version: 1,
  settings: {
    updateMode: "manual",
    intervalDays: 7,
    lastUpdated: new Date().toISOString(),
  },
  categories: {
    "background-removal": {
      userAdded: false,
      spaces: [
        { id: "briaai/BRIA-RMBG-2.0", likes: 2450, source: "builtin" },
        { id: "not-lain/background-removal", likes: 890, source: "builtin" },
        { id: "Xenova/remove-background-web", likes: 748, source: "builtin" },
      ],
    },
    inpainting: {
      userAdded: false,
      spaces: [
        { id: "Sanster/IOPaint", likes: 3200, source: "builtin" },
        { id: "cleanup-pictures/cleanup", likes: 1500, source: "builtin" },
        { id: "parlance/ldm-inpainting", likes: 420, source: "builtin" },
      ],
    },
    upscale: {
      userAdded: false,
      spaces: [
        { id: "doevent/Face-Real-ESRGAN", likes: 1800, source: "builtin" },
        { id: "gokaygokay/TileUpscalerV2", likes: 950, source: "builtin" },
        { id: "nateraw/real-esrgan", likes: 620, source: "builtin" },
      ],
    },
    "face-restore": {
      userAdded: false,
      spaces: [
        { id: "sczhou/CodeFormer", likes: 4100, source: "builtin" },
        { id: "tencentarc/gfpgan", likes: 2800, source: "builtin" },
        { id: "akhaliq/RestoreFormer", likes: 340, source: "builtin" },
      ],
    },
    "text-to-image": {
      userAdded: false,
      spaces: [
        { id: "black-forest-labs/FLUX.1-schnell", likes: 8900, source: "builtin" },
        { id: "stabilityai/stable-diffusion-xl-base-1.0", likes: 7600, source: "builtin" },
        { id: "stabilityai/stable-diffusion-2-1", likes: 5400, source: "builtin" },
      ],
    },
    "image-to-image": {
      userAdded: false,
      spaces: [
        { id: "multimodalart/cosxl", likes: 1200, source: "builtin" },
        { id: "timbrooks/instruct-pix2pix", likes: 2100, source: "builtin" },
        { id: "lllyasviel/sd-webui-controlnet", likes: 4500, source: "builtin" },
      ],
    },
    "text-to-video": {
      userAdded: false,
      spaces: [
        { id: "damo-vilab/modelscope-text-to-video-synthesis", likes: 3200, source: "builtin" },
        { id: "cerspense/zeroscope_v2_XL", likes: 1800, source: "builtin" },
        { id: "strangeman3107/animate-diff", likes: 950, source: "builtin" },
      ],
    },
    "image-to-video": {
      userAdded: false,
      spaces: [
        { id: "stabilityai/stable-video-diffusion", likes: 4100, source: "builtin" },
        { id: "cerspense/zeroscope_v2_576w", likes: 1200, source: "builtin" },
        { id: "ali-vilab/i2vgen-xl", likes: 780, source: "builtin" },
      ],
    },
    "image-to-3d": {
      userAdded: false,
      spaces: [
        { id: "TencentARC/InstantMesh", likes: 5200, source: "builtin" },
        { id: "stabilityai/stable-fast-3d", likes: 1800, source: "builtin" },
        { id: "TencentARC/Unique3D", likes: 950, source: "builtin" },
      ],
    },
    "text-to-speech": {
      userAdded: false,
      spaces: [
        { id: "suno/bark", likes: 6500, source: "builtin" },
        { id: "coqui/xtts", likes: 2100, source: "builtin" },
        { id: "facebook/mms", likes: 1200, source: "builtin" },
      ],
    },
    transcription: {
      userAdded: false,
      spaces: [
        { id: "openai/whisper", likes: 9800, source: "builtin" },
        { id: "hf-audio/whisper-large-v3", likes: 1200, source: "builtin" },
        { id: "jonatasgrosman/whisper-large-v2-portuguese", likes: 450, source: "builtin" },
      ],
    },
    "music-generation": {
      userAdded: false,
      spaces: [
        { id: "facebook/musicgen", likes: 3200, source: "builtin" },
        { id: "facebook/audiocraft", likes: 2800, source: "builtin" },
        { id: "riffusion/riffusion", likes: 1900, source: "builtin" },
      ],
    },
  },
}

const TASK_MAP: Record<string, string> = {
  "remove background": "background-removal",
  "remove bg": "background-removal",
  "background removal": "background-removal",
  "remove object": "inpainting",
  "inpaint": "inpainting",
  "object removal": "inpainting",
  "cleanup": "inpainting",
  "upscale": "upscale",
  "super resolution": "upscale",
  "enhance": "upscale",
  "face restore": "face-restore",
  "restore face": "face-restore",
  "face enhancement": "face-restore",
  "text to image": "text-to-image",
  "generate image": "text-to-image",
  "image generation": "text-to-image",
  "image to image": "image-to-image",
  "img2img": "image-to-image",
  "style transfer": "image-to-image",
  "text to video": "text-to-video",
  "generate video": "text-to-video",
  "video generation": "text-to-video",
  "image to video": "image-to-video",
  "img2vid": "image-to-video",
  "image to 3d": "image-to-3d",
  "3d generation": "image-to-3d",
  "text to speech": "text-to-speech",
  tts: "text-to-speech",
  "speech synthesis": "text-to-speech",
  transcribe: "transcription",
  transcription: "transcription",
  "speech to text": "transcription",
  music: "music-generation",
  "music generation": "music-generation",
  "generate music": "music-generation",
}

function resolveCategory(task: string): string | null {
  const normalized = task.toLowerCase().trim()
  for (const [pattern, category] of Object.entries(TASK_MAP)) {
    if (normalized.includes(pattern)) return category
  }
  return null
}

export async function load(): Promise<Registry> {
  try {
    const data = await Filesystem.readJson<Registry>(REGISTRY_FILE)
    if (data && data.version === 1) return data
  } catch {
    // fall through to default
  }
  return { ...DEFAULT_REGISTRY }
}

async function save(reg: Registry): Promise<void> {
  await Filesystem.writeJson(REGISTRY_FILE, reg)
}

export async function update(token?: string): Promise<{ updated: number; categories: string[] }> {
  const reg = await load()
  const updated: string[] = []

  for (const [name, category] of Object.entries(reg.categories)) {
    if (category.userAdded) continue
    try {
      const results = await HfSpaces.searchForSpace(name.replace(/-/g, " "), token)
      const top3 = results.slice(0, 3)
      if (top3.length > 0) {
        const userSpaces = category.spaces.filter((s) => s.source === "user")
        category.spaces = [
          ...userSpaces,
          ...top3.map((s) => ({
            id: s.id,
            likes: s.likes,
            source: "fetched" as const,
          })),
        ]
        updated.push(name)
      }
    } catch (e) {
      log.error("failed to update category", { category: name, error: e })
    }
  }

  reg.settings.lastUpdated = new Date().toISOString()
  await save(reg)

  return { updated: updated.length, categories: updated }
}

export async function shouldAutoUpdate(): Promise<boolean> {
  const reg = await load()
  if (reg.settings.updateMode !== "auto") return false
  const last = new Date(reg.settings.lastUpdated)
  const now = new Date()
  const diffDays = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24)
  return diffDays >= reg.settings.intervalDays
}

export async function getSpacesForTask(task: string, token?: string): Promise<HfSpaces.SpaceResult[]> {
  const reg = await load()
  const category = resolveCategory(task)

  if (category && reg.categories[category]) {
    const spaces = reg.categories[category].spaces
    const userSpaces = spaces.filter((s) => s.source === "user").map((s) => ({ id: s.id, likes: s.likes }))
    const builtinSpaces = spaces.filter((s) => s.source !== "user").map((s) => ({ id: s.id, likes: s.likes }))
    const combined = [...userSpaces, ...builtinSpaces]
    if (combined.length > 0) return combined
  }

  // Fallback to live search
  log.info("no registry match, using live search", { task })
  return HfSpaces.searchForSpace(task, token)
}

export async function addSpace(
  category: string,
  spaceId: string,
  note?: string,
): Promise<boolean> {
  const reg = await load()
  if (!reg.categories[category]) {
    reg.categories[category] = { spaces: [], userAdded: true }
  }

  const exists = reg.categories[category].spaces.some((s) => s.id === spaceId)
  if (exists) return false

  let likes = 0
  try {
    const results = await HfSpaces.searchForSpace(spaceId.split("/")[1] || spaceId)
    const match = results.find((s) => s.id === spaceId)
    if (match) likes = match.likes
  } catch {
    // ignore
  }

  reg.categories[category].spaces.push({
    id: spaceId,
    likes,
    source: "user",
    note,
  })

  await save(reg)
  return true
}

export async function removeSpace(category: string, spaceId: string): Promise<boolean> {
  const reg = await load()
  if (!reg.categories[category]) return false

  const before = reg.categories[category].spaces.length
  reg.categories[category].spaces = reg.categories[category].spaces.filter((s) => s.id !== spaceId)
  const after = reg.categories[category].spaces.length

  if (before === after) return false
  await save(reg)
  return true
}

export async function addCategory(name: string): Promise<boolean> {
  const reg = await load()
  const key = name.toLowerCase().replace(/\s+/g, "-")
  if (reg.categories[key]) return false

  reg.categories[key] = {
    spaces: [],
    userAdded: true,
  }
  await save(reg)
  return true
}

export async function removeCategory(name: string): Promise<boolean> {
  const reg = await load()
  const key = name.toLowerCase().replace(/\s+/g, "-")
  const cat = reg.categories[key]
  if (!cat) return false
  if (!cat.userAdded) return false

  delete reg.categories[key]
  await save(reg)
  return true
}

export async function updateSettings(mode: "manual" | "auto", intervalDays?: number): Promise<void> {
  const reg = await load()
  reg.settings.updateMode = mode
  if (intervalDays !== undefined) reg.settings.intervalDays = intervalDays
  await save(reg)
}

export async function getSummary(): Promise<string> {
  const reg = await load()
  const lines = [
    "Media Spaces Registry",
    `Update mode: ${reg.settings.updateMode}`,
    `Last updated: ${reg.settings.lastUpdated}`,
    `Categories: ${Object.keys(reg.categories).length}`,
    "",
  ]

  for (const [name, cat] of Object.entries(reg.categories)) {
    const userCount = cat.spaces.filter((s) => s.source === "user").length
    lines.push(`- ${name}: ${cat.spaces.length} spaces${userCount > 0 ? ` (${userCount} user-added)` : ""}`)
  }

  return lines.join("\n")
}

export async function listCategories(): Promise<string[]> {
  const reg = await load()
  return Object.keys(reg.categories)
}

export async function listSpaces(category: string): Promise<SpaceEntry[]> {
  const reg = await load()
  return reg.categories[category]?.spaces ?? []
}
