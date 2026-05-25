import crypto from "crypto"
import path from "path"
import { Global } from "@/global"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
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

const log = Log.create({ service: "supermemory-backend" })

function getTags(directory: string) {
  const gitEmail = process.env.GIT_AUTHOR_EMAIL || process.env.GIT_COMMITTER_EMAIL || "user"
  const userHash = crypto.createHash("sha256").update(gitEmail).digest("hex").slice(0, 12)
  const dirHash = crypto.createHash("sha256").update(directory).digest("hex").slice(0, 12)
  return {
    user: `handofai_user_${userHash}`,
    project: `handofai_project_${dirHash}`,
  }
}

export class SupermemoryBackend implements MemoryBackend {
  readonly id = "supermemory"
  readonly name = "Supermemory"
  enabled = false
  configured = false

  private client: any = null
  private tags: { user: string; project: string } | null = null

  async init() {
    const cfg = await this.getConfig()
    if (!cfg?.enabled) {
      this.enabled = false
      this.configured = false
      return
    }

    const apiKey = cfg.api_key || process.env.SUPERMEMORY_API_KEY
    if (!apiKey) {
      this.configured = false
      return
    }

    try {
      // @ts-ignore optional dependency
      const { default: Supermemory } = await import("supermemory")
      this.client = new Supermemory({ apiKey })
      this.enabled = true
      this.configured = true

      const { Instance } = await import("@/project/instance")
      const dir = Instance.directory || process.cwd()
      this.tags = getTags(dir)

      if (cfg.user_container_tag) this.tags.user = cfg.user_container_tag
      if (cfg.project_container_tag) this.tags.project = cfg.project_container_tag

      log.info("initialized", { userTag: this.tags.user, projectTag: this.tags.project })
    } catch (err) {
      log.warn("supermemory sdk not installed. Run: bun add supermemory")
      this.configured = false
    }
  }

  private async getConfig() {
    const cfg = await Config.getGlobal().catch(() => ({} as any))
    return cfg.memory?.backends?.supermemory
  }

  private containerTag(target: "memory" | "user") {
    return target === "user" ? this.tags!.user : this.tags!.project
  }

  async add(entry: MemoryEntry): Promise<AddResult> {
    if (!this.client || !this.configured) return { success: false, error: "Supermemory not configured" }

    try {
      const result = await this.client.add({
        content: entry.content,
        containerTag: this.containerTag(entry.target),
        metadata: {
          type: entry.type,
          source: entry.source || "manual",
          ...entry.metadata,
        },
      })
      return { success: true, id: result.id }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error("add failed", { error: msg })
      return { success: false, error: msg }
    }
  }

  async remove(id: string): Promise<RemoveResult> {
    if (!this.client || !this.configured) return { success: false, error: "Supermemory not configured" }

    try {
      await this.client.documents.delete({ docId: id })
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  async search(query: string, opts?: SearchOpts): Promise<MemoryResult[]> {
    if (!this.client || !this.configured) return []
    const cfg = await this.getConfig()
    const limit = opts?.limit ?? cfg?.max_memories ?? 5

    try {
      const targets = opts?.target ? [opts.target] : ["memory", "user"] as const
      const all: MemoryResult[] = []

      for (const target of targets) {
        const result = await this.client.search.documents({
          q: query,
          containerTags: [this.containerTag(target)],
        })
        const docs = result.results || []
        for (const r of docs) {
          all.push({
            id: r.id,
            content: r.memory || r.chunk || "",
            type: (r.metadata?.type as MemoryType) || "text",
            target,
            score: r.similarity,
            metadata: r.metadata,
          })
        }
      }

      all.sort((a, b) => (b.score || 0) - (a.score || 0))
      return all.slice(0, limit)
    } catch (err) {
      log.error("search failed", { error: err })
      return []
    }
  }

  async list(opts?: ListOpts): Promise<MemoryResult[]> {
    if (!this.client || !this.configured) return []

    try {
      const targets = opts?.target ? [opts.target] : ["memory", "user"] as const
      const all: MemoryResult[] = []

      for (const target of targets) {
        const result = await this.client.documents.list({
          containerTags: [this.containerTag(target)],
          limit: opts?.limit ?? 20,
        })
        const docs = result.memories || []
        for (const r of docs) {
          all.push({
            id: r.id,
            content: r.summary || r.content || "",
            type: (r.metadata?.type as MemoryType) || "text",
            target,
            metadata: r.metadata,
            createdAt: r.createdAt,
          })
        }
      }
      return all
    } catch (err) {
      log.error("list failed", { error: err })
      return []
    }
  }

  supports(type: MemoryType): boolean {
    return true // Supermemory supports all types via extractors
  }
}
