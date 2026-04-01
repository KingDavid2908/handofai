import path from "path"
import { mkdir } from "fs/promises"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Config } from "@/config/config"

const MEMORY_DIR = path.join(Global.Path.config, "memories")
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md")
const USER_FILE = path.join(MEMORY_DIR, "USER.md")

const ENTRY_DELIMITER = "\n§\n"

const MEMORY_CHAR_LIMIT = 2200
const USER_CHAR_LIMIT = 1375

const MEMORY_THREAT_PATTERNS = [
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

export namespace MemoryStore {
  export type Target = "memory" | "user"

  export interface Entry {
    content: string
  }

  export interface Snapshot {
    memory: string
    user: string
    memoryUsage: { used: number; limit: number; percent: number }
    userUsage: { used: number; limit: number; percent: number }
  }

  export interface LiveState {
    memoryEntries: string[]
    userEntries: string[]
  }

  let snapshot: Snapshot | null = null
  let live: LiveState | null = null

  /**
   * Check if the memory system is enabled in config.
   * Returns true if memory.enabled is not explicitly set to false.
   */
  export async function isEnabled(): Promise<boolean> {
    try {
      const cfg = await Config.getGlobal()
      const memCfg = (cfg as any).memory
      if (memCfg && memCfg.enabled === false) return false
      return true
    } catch {
      // If config can't be read, default to enabled
      return true
    }
  }

  export async function init() {
    await mkdir(MEMORY_DIR, { recursive: true })
    await load()
  }

  export async function load() {
    const memoryContent = await Filesystem.readText(MEMORY_FILE).catch(() => "")
    const userContent = await Filesystem.readText(USER_FILE).catch(() => "")

    const memoryEntries = memoryContent ? memoryContent.split(ENTRY_DELIMITER).filter((e) => e.trim()) : []
    const userEntries = userContent ? userContent.split(ENTRY_DELIMITER).filter((e) => e.trim()) : []

    live = { memoryEntries, userEntries }
    snapshot = buildSnapshot(memoryEntries, userEntries)
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

  export async function add(target: Target, content: string): Promise<{ success: boolean; error?: string; entries?: string[]; usage?: string }> {
    if (!await isEnabled()) {
      return { success: false, error: "Memory system is disabled. Enable it in config or via /memory toggle." }
    }
    if (!live) await init()
    if (!live) throw new Error("MemoryStore not initialized")

    const scanResult = scanContent(content)
    if (scanResult) return { success: false, error: scanResult }

    const entries = target === "memory" ? live.memoryEntries : live.userEntries
    const limit = target === "memory" ? MEMORY_CHAR_LIMIT : USER_CHAR_LIMIT

    if (entries.includes(content)) {
      return { success: true, error: "no duplicate added", entries, usage: formatUsage(entries, limit) }
    }

    const newTotal = calcTotal([...entries, content])
    if (newTotal > limit) {
      return {
        success: false,
        error: `Memory at ${calcTotal(entries)}/${limit} chars. Adding this entry (${content.length} chars) would exceed the limit. Replace or remove existing entries first.`,
        entries,
        usage: formatUsage(entries, limit),
      }
    }

    entries.push(content)
    await write(target, entries)
    return { success: true, entries: [...entries], usage: formatUsage(entries, limit) }
  }

  export async function replace(target: Target, oldText: string, content: string): Promise<{ success: boolean; error?: string; entries?: string[]; usage?: string }> {
    if (!await isEnabled()) {
      return { success: false, error: "Memory system is disabled. Enable it in config or via /memory toggle." }
    }
    if (!live) await init()
    if (!live) throw new Error("MemoryStore not initialized")

    const scanResult = scanContent(content)
    if (scanResult) return { success: false, error: scanResult }

    const entries = target === "memory" ? live.memoryEntries : live.userEntries
    const limit = target === "memory" ? MEMORY_CHAR_LIMIT : USER_CHAR_LIMIT

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
    await write(target, entries)
    return { success: true, entries: [...entries], usage: formatUsage(entries, limit) }
  }

  export async function remove(target: Target, oldText: string): Promise<{ success: boolean; error?: string; entries?: string[]; usage?: string }> {
    if (!await isEnabled()) {
      return { success: false, error: "Memory system is disabled. Enable it in config or via /memory toggle." }
    }
    if (!live) await init()
    if (!live) throw new Error("MemoryStore not initialized")

    const entries = target === "memory" ? live.memoryEntries : live.userEntries
    const limit = target === "memory" ? MEMORY_CHAR_LIMIT : USER_CHAR_LIMIT

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
    await write(target, entries)
    return { success: true, entries: [...entries], usage: formatUsage(entries, limit) }
  }

  export async function clear(target: Target): Promise<void> {
    if (!live) {
      await init()
    }
    if (!live) throw new Error("MemoryStore not initialized")

    // Clear in-memory state
    const entries = target === "memory" ? live.memoryEntries : live.userEntries
    entries.length = 0

    // Write empty content to file
    const file = target === "memory" ? MEMORY_FILE : USER_FILE
    await Filesystem.write(file, "")

    // Verify the file is empty
    const verifyContent = await Filesystem.readText(file).catch(() => "VERIFY_FAILED")
    if (verifyContent !== "") {
      throw new Error(`Failed to verify clear: file contains "${verifyContent.slice(0, 50)}"`)
    }

    // Update snapshot
    snapshot = buildSnapshot(live.memoryEntries, live.userEntries)
  }

  async function write(target: Target, entries: string[]) {
    const file = target === "memory" ? MEMORY_FILE : USER_FILE
    const content = entries.join(ENTRY_DELIMITER)
    await Filesystem.write(file, content)
    snapshot = buildSnapshot(live!.memoryEntries, live!.userEntries)
  }

  function buildSnapshot(memoryEntries: string[], userEntries: string[]): Snapshot {
    return {
      memory: memoryEntries.join(ENTRY_DELIMITER),
      user: userEntries.join(ENTRY_DELIMITER),
      memoryUsage: calcUsage(memoryEntries, MEMORY_CHAR_LIMIT),
      userUsage: calcUsage(userEntries, USER_CHAR_LIMIT),
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
    const { used, percent } = calcUsage(entries, limit)
    return `${used}/${limit}`
  }

  function scanContent(content: string): string | null {
    for (const pattern of MEMORY_THREAT_PATTERNS) {
      if (pattern.test(content)) return `Content blocked: matches threat pattern "${pattern.source}"`
    }
    for (const pattern of INVISIBLE_UNICODE_PATTERNS) {
      if (pattern.test(content)) return "Content blocked: contains invisible Unicode characters"
    }
    return null
  }
}
