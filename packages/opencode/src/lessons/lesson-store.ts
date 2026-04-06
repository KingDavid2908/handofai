import path from "path"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Config } from "@/config/config"

const MEMORY_DIR = path.join(Global.Path.config, "memories")
const LESSONS_FILE = path.join(MEMORY_DIR, "LESSONS.md")

const ENTRY_DELIMITER = "\n§\n"

const CHAR_LIMIT = 2200

const THREAT_PATTERNS = [
  /ignore\s+previous\s+instructions/i,
  /you\s+are\s+now/i,
  /do\s+not\s+tell\s+the\s+user/i,
  /system\s+prompt\s+override/i,
  /disregard\s+instructions/i,
  /act\s+as\s+though\s+you\s+have\s+no\s+restrictions/i,
  /curl.*\|.*bash/i,
  /wget.*\|.*sh/i,
  /cat\s+\.env/i,
  /cat\s+.*credentials/i,
  /ssh\s+-R/i,
]

const INVISIBLE_UNICODE_PATTERNS = [
  /\u200B|\u200C|\u200D|\uFEFF/,
  /\u202A|\u202B|\u202D|\u202E/,
]

const META_MESSAGE_PATTERNS = [
  /^nothing\s+to\s+save/i,
  /^session\s+review/i,
  /^no\s+(new\s+)?information\s+to\s+save/i,
  /^nothing\s+(is\s+)?worth\s+(saving|remembering)/i,
  /^no\s+changes\s+needed/i,
  /^review\s+complete/i,
  /^memory\s+review\s+(done|complete|finished)/i,
  /^nothing\s+stands?\s+out/i,
]

export namespace LessonStore {
  export interface Entry {
    content: string
  }

  export interface Snapshot {
    lessons: string
    usage: { used: number; limit: number; percent: number }
  }

  export interface LiveState {
    entries: string[]
  }

  let snapshot: Snapshot | null = null
  let live: LiveState | null = null

  export async function isEnabled(): Promise<boolean> {
    try {
      const cfg = await Config.getGlobal()
      const lessonsCfg = (cfg as any).lessons
      if (lessonsCfg && lessonsCfg.enabled === false) return false
      return true
    } catch {
      return true
    }
  }

  export async function init() {
    const { mkdir } = await import("fs/promises")
    await mkdir(MEMORY_DIR, { recursive: true })
    await load()
  }

  export async function load() {
    const content = await Filesystem.readText(LESSONS_FILE).catch(() => "")

    const entries = content ? content.split(ENTRY_DELIMITER).filter((e) => e.trim()) : []

    live = { entries }
    snapshot = buildSnapshot(entries)
  }

  export function isInitialized(): boolean {
    return live !== null && snapshot !== null
  }

  export function getSnapshot(): Snapshot | null {
    if (!snapshot) return null
    return snapshot
  }

  export function getLive(): LiveState | null {
    if (!live) return null
    return { ...live }
  }

  export async function add(content: string): Promise<{ success: boolean; error?: string; entries?: string[]; usage?: string }> {
    if (!live) await init()
    if (!live) throw new Error("LessonStore not initialized")

    const scanResult = scanContent(content)
    if (scanResult) return { success: false, error: scanResult }

    const limit = CHAR_LIMIT

    if (live.entries.includes(content)) {
      return { success: true, error: "no duplicate added", entries: live.entries, usage: formatUsage(live.entries, limit) }
    }

    const newTotal = calcTotal([...live.entries, content])
    if (newTotal > limit) {
      return {
        success: false,
        error: `Lessons at ${calcTotal(live.entries)}/${limit} chars. Adding this entry (${content.length} chars) would exceed the limit. Replace or remove existing entries first.`,
        entries: live.entries,
        usage: formatUsage(live.entries, limit),
      }
    }

    live.entries.push(content)
    await write(live.entries)
    return { success: true, entries: [...live.entries], usage: formatUsage(live.entries, limit) }
  }

  export async function replace(oldText: string, content: string): Promise<{ success: boolean; error?: string; entries?: string[]; usage?: string }> {
    if (!live) await init()
    if (!live) throw new Error("LessonStore not initialized")

    const scanResult = scanContent(content)
    if (scanResult) return { success: false, error: scanResult }

    const limit = CHAR_LIMIT
    const entries = live.entries

    const matches: number[] = []
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].includes(oldText)) matches.push(i)
    }

    if (matches.length === 0) {
      return { success: false, error: `No entry found matching "${oldText}"`, entries, usage: formatUsage(entries, limit) }
    }
    if (matches.length > 1) {
      const matching = matches.map((i) => entries[i])
      return { success: false, error: `Multiple entries match "${oldText}". Please provide a more specific match.`, entries: matching, usage: formatUsage(entries, limit) }
    }

    entries[matches[0]] = content
    await write(entries)
    return { success: true, entries: [...entries], usage: formatUsage(entries, limit) }
  }

  export async function remove(oldText: string): Promise<{ success: boolean; error?: string; entries?: string[]; usage?: string }> {
    if (!live) await init()
    if (!live) throw new Error("LessonStore not initialized")

    const limit = CHAR_LIMIT
    const entries = live.entries

    const matches: number[] = []
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].includes(oldText)) matches.push(i)
    }

    if (matches.length === 0) {
      return { success: false, error: `No entry found matching "${oldText}"`, entries, usage: formatUsage(entries, limit) }
    }
    if (matches.length > 1) {
      const matching = matches.map((i) => entries[i])
      return { success: false, error: `Multiple entries match "${oldText}". Please provide a more specific match.`, entries: matching, usage: formatUsage(entries, limit) }
    }

    entries.splice(matches[0], 1)
    await write(entries)
    return { success: true, entries: [...entries], usage: formatUsage(entries, limit) }
  }

  export async function clear(): Promise<void> {
    if (!live) {
      await init()
    }
    if (!live) throw new Error("LessonStore not initialized")

    live.entries.length = 0

    await Filesystem.write(LESSONS_FILE, "")

    const verifyContent = await Filesystem.readText(LESSONS_FILE).catch(() => "VERIFY_FAILED")
    if (verifyContent !== "") {
      throw new Error(`Failed to verify clear: file contains "${verifyContent.slice(0, 50)}"`)
    }

    snapshot = buildSnapshot(live.entries)
  }

  async function write(entries: string[]) {
    const content = entries.join(ENTRY_DELIMITER)
    await Filesystem.write(LESSONS_FILE, content)
    snapshot = buildSnapshot(live!.entries)
  }

  function buildSnapshot(entries: string[]): Snapshot {
    return {
      lessons: entries.join(ENTRY_DELIMITER),
      usage: calcUsage(entries, CHAR_LIMIT),
    }
  }

  function calcUsage(entries: string[], limit: number) {
    const used = calcTotal(entries)
    return { used, limit, percent: Math.round((used / limit) * 100) }
  }

  function calcTotal(entries: string[]): number {
    return entries.reduce((sum, e) => sum + e.length + ENTRY_DELIMITER.length, 0) - (entries.length > 0 ? ENTRY_DELIMITER.length : 0)
  }

  function formatUsage(entries: string[], limit: number): string {
    const { used } = calcUsage(entries, limit)
    return `${used}/${limit}`
  }

  function scanContent(content: string): string | null {
    for (const pattern of THREAT_PATTERNS) {
      if (pattern.test(content)) return `Content blocked: matches threat pattern "${pattern.source}"`
    }
    for (const pattern of INVISIBLE_UNICODE_PATTERNS) {
      if (pattern.test(content)) return "Content blocked: contains invisible Unicode characters"
    }
    for (const pattern of META_MESSAGE_PATTERNS) {
      if (pattern.test(content)) return `Content blocked: appears to be a review status message, not a lesson entry`
    }
    return null
  }
}
