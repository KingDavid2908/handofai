import path from "path"
import { mkdir } from "fs/promises"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Config } from "@/config/config"
import type {
  MemoryBackend,
  MemoryEntry,
  MemoryResult,
  AddResult,
  RemoveResult,
  SearchOpts,
  ListOpts,
  MemoryType,
} from "./backend"

const MEMORY_DIR = path.join(Global.Path.config, "memories")
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md")
const USER_FILE = path.join(MEMORY_DIR, "USER.md")
const ENTRY_DELIMITER = "\n§\n"

const MEMORY_CHAR_LIMIT = 2200
const USER_CHAR_LIMIT = 1375

export class LocalBackend implements MemoryBackend {
  readonly id = "local"
  readonly name = "Local"
  enabled = true
  configured = true

  private live: { memoryEntries: string[]; userEntries: string[] } | null = null

  async init() {
    await mkdir(MEMORY_DIR, { recursive: true })
    await this.load()
  }

  async load() {
    const memoryContent = await Filesystem.readText(MEMORY_FILE).catch(() => "")
    const userContent = await Filesystem.readText(USER_FILE).catch(() => "")
    this.live = {
      memoryEntries: memoryContent ? memoryContent.split(ENTRY_DELIMITER).filter((e) => e.trim()) : [],
      userEntries: userContent ? userContent.split(ENTRY_DELIMITER).filter((e) => e.trim()) : [],
    }
  }

  private async getConfig() {
    const cfg = await Config.getGlobal().catch(() => ({} as any))
    return cfg.memory ?? {}
  }

  private charLimit(target: "memory" | "user") {
    return target === "memory" ? MEMORY_CHAR_LIMIT : USER_CHAR_LIMIT
  }

  private entries(target: "memory" | "user") {
    if (!this.live) throw new Error("LocalBackend not initialized")
    return target === "memory" ? this.live.memoryEntries : this.live.userEntries
  }

  private async write(target: "memory" | "user") {
    const file = target === "memory" ? MEMORY_FILE : USER_FILE
    const list = this.entries(target)
    await Filesystem.write(file, list.join(ENTRY_DELIMITER))
  }

  async add(entry: MemoryEntry): Promise<AddResult> {
    if (!this.live) await this.init()
    const cfg = await this.getConfig()
    const limit = cfg.memory_char_limit ?? this.charLimit(entry.target)
    const list = this.entries(entry.target)

    if (list.includes(entry.content)) {
      return { success: true }
    }

    const newTotal = list.reduce((sum, e) => sum + e.length + ENTRY_DELIMITER.length, 0) + entry.content.length
    if (newTotal > limit + ENTRY_DELIMITER.length) {
      return { success: false, error: `Local memory at capacity (${limit} chars)` }
    }

    // For non-text, store description + reference instead of binary
    const content = entry.type !== "text"
      ? `[${entry.type.toUpperCase()}] ${entry.content}`
      : entry.content

    list.push(content)
    await this.write(entry.target)
    return { success: true }
  }

  async remove(id: string): Promise<RemoveResult> {
    if (!this.live) await this.init()
    for (const target of ["memory", "user"] as const) {
      const list = this.entries(target)
      const idx = list.findIndex((e) => e.includes(id))
      if (idx >= 0) {
        list.splice(idx, 1)
        await this.write(target)
        return { success: true }
      }
    }
    return { success: false, error: "Entry not found" }
  }

  async search(query: string, opts?: SearchOpts): Promise<MemoryResult[]> {
    if (!this.live) await this.init()
    const results: MemoryResult[] = []
    const targets = opts?.target ? [opts.target] : ["memory", "user"] as const

    for (const target of targets) {
      const list = this.entries(target)
      for (const entry of list) {
        if (entry.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            id: `${target}-${Buffer.from(entry).toString("base64").slice(0, 16)}`,
            content: entry,
            type: "text",
            target,
          })
        }
      }
    }
    return results.slice(0, opts?.limit ?? 50)
  }

  async list(opts?: ListOpts): Promise<MemoryResult[]> {
    if (!this.live) await this.init()
    const results: MemoryResult[] = []
    const targets = opts?.target ? [opts.target] : ["memory", "user"] as const

    for (const target of targets) {
      const list = this.entries(target)
      for (const entry of list) {
        results.push({
          id: `${target}-${Buffer.from(entry).toString("base64").slice(0, 16)}`,
          content: entry,
          type: "text",
          target,
        })
      }
    }
    return results.slice(0, opts?.limit ?? 50)
  }

  supports(type: MemoryType): boolean {
    return true // Local stores all types as text references
  }

  snapshot() {
    if (!this.live) return null
    return {
      memory: this.live.memoryEntries.join(ENTRY_DELIMITER),
      user: this.live.userEntries.join(ENTRY_DELIMITER),
      memoryUsage: this.calcUsage(this.live.memoryEntries, MEMORY_CHAR_LIMIT),
      userUsage: this.calcUsage(this.live.userEntries, USER_CHAR_LIMIT),
    }
  }

  private calcUsage(entries: string[], limit: number) {
    const used = entries.reduce((sum, e) => sum + e.length + ENTRY_DELIMITER.length, 0) - (entries.length > 0 ? ENTRY_DELIMITER.length : 0)
    return { used, limit, percent: Math.round((used / limit) * 100) }
  }
}
