import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type {
  MemoryBackend,
  MemoryEntry,
  MemoryResult,
  AddResult,
  RemoveResult,
  SearchOpts,
  ListOpts,
  MemoryType,
  MemoryCategory,
} from "./backends/backend"
import { LocalBackend } from "./backends/local-backend"
import { SupermemoryBackend } from "./backends/supermemory-backend"
import { GraphlitBackend } from "./backends/graphlit-backend"

const log = Log.create({ service: "memory-router" })

function mapTypeToCategory(type: MemoryType): MemoryCategory {
  switch (type) {
    case "text": return "project_knowledge"
    case "image": return "images"
    case "video": return "videos"
    case "audio": return "audio"
    case "document": return "documents"
  }
}

export class MemoryRouter {
  private backends: MemoryBackend[] = []
  private initialized = false

  async init() {
    if (this.initialized) return

    const cfg = await Config.getGlobal().catch(() => ({} as any))
    const memCfg = cfg.memory ?? {}

    // Always init local
    const local = new LocalBackend()
    if (memCfg.backends?.local?.enabled !== false) {
      local.enabled = true
      await local.init()
    }
    this.backends.push(local)

    // Init supermemory if enabled
    if (memCfg.backends?.supermemory?.enabled) {
      const sm = new SupermemoryBackend()
      await sm.init()
      this.backends.push(sm)
    }

    // Init graphlit if enabled
    if (memCfg.backends?.graphlit?.enabled) {
      const gl = new GraphlitBackend()
      await gl.init()
      this.backends.push(gl)
    }

    this.initialized = true
    log.info("initialized", {
      backends: this.backends.filter((b) => b.configured).map((b) => b.id),
    })
  }

  private activeBackends(): MemoryBackend[] {
    return this.backends.filter((b) => b.enabled && b.configured)
  }

  private selectBackends(entry: MemoryEntry): MemoryBackend[] {
    const cfg = Config.getGlobal() as any
    const memCfg = cfg.memory ?? {}
    const all = this.activeBackends()

    const routingKey = entry.category ?? mapTypeToCategory(entry.type)

    // Primary: filter by use_for
    const matched = all.filter((b) => {
      const backendCfg = memCfg.backends?.[b.id]
      if (!backendCfg?.use_for) return true
      return backendCfg.use_for.includes(routingKey)
    })

    // Fallback: if no match, send to any backend that supports the type
    if (matched.length === 0) {
      return all.filter((b) => b.supports(entry.type))
    }

    return matched
  }

  async add(entry: MemoryEntry): Promise<AddResult[]> {
    await this.init()
    const targets = this.selectBackends(entry)
    const results = await Promise.all(
      targets.map((b) => b.add(entry).then((r) => ({ backend: b.id, ...r }))),
    )
    return results
  }

  async remove(id: string): Promise<RemoveResult[]> {
    await this.init()
    const all = this.activeBackends()
    const results = await Promise.all(
      all.map((b) => b.remove(id).then((r) => ({ backend: b.id, ...r }))),
    )
    return results
  }

  async search(query: string, opts?: SearchOpts): Promise<MemoryResult[]> {
    await this.init()
    const all = this.activeBackends()
    const lists = await Promise.all(all.map((b) => b.search(query, opts)))
    const combined = lists.flat().sort((a, b) => (b.score || 0) - (a.score || 0))
    return combined.slice(0, opts?.limit ?? 50)
  }

  async list(opts?: ListOpts): Promise<MemoryResult[]> {
    await this.init()
    const all = this.activeBackends()
    const lists = await Promise.all(all.map((b) => b.list(opts)))
    return lists.flat().slice(0, opts?.limit ?? 50)
  }

  snapshot() {
    const local = this.backends.find((b) => b.id === "local")
    if (local && local instanceof LocalBackend) {
      return local.snapshot()
    }
    return null
  }

  isInitialized() {
    return this.initialized
  }

  status() {
    return this.backends.map((b) => ({
      id: b.id,
      name: b.name,
      enabled: b.enabled,
      configured: b.configured,
    }))
  }

  getBackend(id: string): MemoryBackend | undefined {
    return this.backends.find((b) => b.id === id && b.enabled && b.configured)
  }
}
