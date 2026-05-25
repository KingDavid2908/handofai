import { Log } from "@/util/log"
import { MemoryStore } from "./memory-store"
import { MemoryRouter } from "./router"

const log = Log.create({ service: "memory-context" })

export namespace MemoryContextInject {
  export interface ContextResult {
    text: string
    hasData: boolean
  }

  export async function build(query?: string): Promise<ContextResult> {
    const parts: string[] = ["[MEMORY CONTEXT]"]
    let hasData = false

    // 1. Local memories
    const local = MemoryStore.getSnapshot()
    if (local) {
      if (local.memory.trim()) {
        parts.push("\nProject Knowledge (Local):")
        parts.push(local.memory)
        hasData = true
      }
      if (local.user.trim()) {
        parts.push("\nUser Profile (Local):")
        parts.push(local.user)
        hasData = true
      }
    }

    // 2. Cloud backends via router
    try {
      const router = await MemoryStore.getRouter()

      // Search user memories
      const userResults = await router.search(query || "user preferences profile", { target: "user", limit: 5 })
      if (userResults.length > 0) {
        parts.push("\nUser Memories:")
        for (const r of userResults) {
          const score = Math.round((r.score || 0) * 100)
          parts.push(`- [${score}%] ${r.content}`)
        }
        hasData = true
      }

      // Search project memories
      const projectResults = await router.search(query || "project architecture configuration", {
        target: "memory",
        limit: 5,
      })
      if (projectResults.length > 0) {
        parts.push("\nProject Memories:")
        for (const r of projectResults) {
          const score = Math.round((r.score || 0) * 100)
          parts.push(`- [${score}%] ${r.content}`)
        }
        hasData = true
      }
    } catch (err) {
      log.warn("cloud context search failed", { error: err })
    }

    if (!hasData) {
      return { text: "", hasData: false }
    }

    return { text: parts.join("\n"), hasData: true }
  }

  export async function injectOnFirstMessage(sessionID: string): Promise<string | null> {
    const ctx = await build()
    if (!ctx.hasData) return null
    return ctx.text
  }
}
