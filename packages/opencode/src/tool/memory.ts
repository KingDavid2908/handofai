import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./memory.txt"
import { MemoryStore } from "../memory/memory-store"
import { MemoryContextInject } from "../memory/context-inject"
import type { MemoryCategory, MemoryType } from "../memory/backends/backend"

const MEMORY_CHAR_LIMIT = 2200
const USER_CHAR_LIMIT = 1375

export const MemoryTool = Tool.define("memory", {
  description: DESCRIPTION,
  parameters: z.object({
    action: z.enum(["add", "replace", "remove", "search", "list", "status", "retrieve"]).describe("Action to perform on memory."),
    target: z.enum(["memory", "user"]).describe("Which memory to modify: 'memory' for your notes, 'user' for facts about the user.").optional(),
    content: z.string().optional().describe("Content to add (for 'add') or replace with (for 'replace')."),
    old_text: z.string().optional().describe("Text to find for 'replace' or 'remove' actions."),
    backend: z.enum(["auto", "local", "supermemory", "graphlit"]).optional()
      .describe("Which backend to use. 'auto' picks based on config and content type."),
    type: z.enum(["text", "image", "video", "audio", "document"]).optional()
      .describe("Content type for multi-modal memories. Defaults to text."),
    category: z.enum([
      "user_preferences", "project_knowledge", "code_patterns", "errors",
      "conversations", "images", "videos", "audio", "documents"
    ]).optional()
      .describe("Category for routing. Controls which backend receives the entry. Auto-detected for text if not provided."),
    query: z.string().optional().describe("Search query for search/list/retrieve actions."),
  }),
  async execute(params, _ctx) {
    const enabled = await MemoryStore.isEnabled()
    if (!enabled) {
      return {
        title: "error",
        output: "Memory system is disabled. The user has disabled memory in config. Do not attempt to use this tool until the user re-enables it.",
        metadata: { error: "memory_disabled" } as Record<string, unknown>,
      }
    }

    if (!MemoryStore.isInitialized()) {
      await MemoryStore.init().catch(() => {})
      if (!MemoryStore.isInitialized()) {
        return {
          title: "error",
          output: "Memory system not initialized.",
          metadata: { error: "not_initialized" } as Record<string, unknown>,
        }
      }
    }

    const { action } = params
    const target = params.target || "memory"

    if (action === "add") {
      if (!params.content) {
        return { title: "error", output: "content is required for 'add' action", metadata: { error: "missing_content" } as Record<string, unknown> }
      }

      // Route to specific backend if requested
      if (params.backend && params.backend !== "auto") {
        const router = await MemoryStore.getRouter()
        const backend = router.getBackend(params.backend)

        if (!backend) {
          return {
            title: "error",
            output: `Backend "${params.backend}" is not configured or not enabled`,
            metadata: { error: "backend_not_available" } as Record<string, unknown>,
          }
        }

        const result = await backend.add({
          content: params.content,
          type: (params.type || "text") as MemoryType,
          category: params.category as MemoryCategory | undefined,
          target,
          source: "manual",
        })

        return {
          title: result.success ? `added to ${params.backend}` : "failed",
          output: result.success
            ? `Added to ${params.backend} only`
            : `Failed: ${result.error}`,
          metadata: { backend: params.backend, ...result } as Record<string, unknown>,
        }
      }

      const result = await MemoryStore.add(target, params.content)
      return {
        title: result.success ? `added to ${target}` : "failed",
        output: result.success
          ? `Added to ${target}.\n\nCurrent ${target} state (${result.usage}):\n${(result.entries ?? []).join("\n§\n")}`
          : `Failed: ${result.error}`,
        metadata: { success: result.success, entries: result.entries, usage: result.usage, error: result.error || "" } as Record<string, unknown>,
      }
    }

    if (action === "replace") {
      if (!params.content) {
        return { title: "error", output: "content is required for 'replace' action", metadata: { error: "missing_content" } as Record<string, unknown> }
      }
      if (!params.old_text) {
        return { title: "error", output: "old_text is required for 'replace' action", metadata: { error: "missing_old_text" } as Record<string, unknown> }
      }
      const result = await MemoryStore.replace(target, params.old_text, params.content)
      return {
        title: result.success ? `replaced in ${target}` : "failed",
        output: result.success
          ? `Replaced in ${target}.\n\nCurrent ${target} state (${result.usage}):\n${(result.entries ?? []).join("\n§\n")}`
          : `Failed: ${result.error}`,
        metadata: { success: result.success, entries: result.entries, usage: result.usage, error: result.error || "" } as Record<string, unknown>,
      }
    }

    if (action === "remove") {
      if (!params.old_text) {
        return { title: "error", output: "old_text is required for 'remove' action", metadata: { error: "missing_old_text" } as Record<string, unknown> }
      }
      const result = await MemoryStore.remove(target, params.old_text)
      return {
        title: result.success ? `removed from ${target}` : "failed",
        output: result.success
          ? `Removed from ${target}.\n\nCurrent ${target} state (${result.usage}):\n${(result.entries ?? []).join("\n§\n")}`
          : `Failed: ${result.error}`,
        metadata: { success: result.success, entries: result.entries, usage: result.usage, error: result.error || "" } as Record<string, unknown>,
      }
    }

    if (action === "search") {
      if (!params.query) {
        return { title: "error", output: "query is required for 'search' action", metadata: { error: "missing_query" } as Record<string, unknown> }
      }
      const router = await MemoryStore.getRouter()
      const results = await router.search(params.query, { target: params.target, limit: 10 })
      if (results.length === 0) {
        return { title: "no results", output: `No memories found for "${params.query}"`, metadata: { count: 0 } as Record<string, unknown> }
      }
      const lines = results.map((r) => `[${(r as any).backend || r.target}] ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}`)
      return {
        title: `search: ${results.length} results`,
        output: lines.join("\n\n---\n\n"),
        metadata: { count: results.length, results } as Record<string, unknown>,
      }
    }

    if (action === "list") {
      const router = await MemoryStore.getRouter()
      const results = await router.list({ target: params.target, limit: 20 })
      if (results.length === 0) {
        return { title: "empty", output: "No memories found.", metadata: { count: 0 } as Record<string, unknown> }
      }
      const lines = results.map((r) => `[${(r as any).backend || r.target}] ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}`)
      return {
        title: `list: ${results.length} memories`,
        output: lines.join("\n\n---\n\n"),
        metadata: { count: results.length, results } as Record<string, unknown>,
      }
    }

    if (action === "retrieve") {
      const ctx = await MemoryContextInject.build(params.query)
      if (!ctx.hasData) {
        return {
          title: "no context",
          output: "No memory context available. The memory system may be empty or disabled.",
          metadata: { hasData: false } as Record<string, unknown>,
        }
      }
      return {
        title: "memory context",
        output: ctx.text,
        metadata: { hasData: true, length: ctx.text.length } as Record<string, unknown>,
      }
    }

    if (action === "status") {
      const router = await MemoryStore.getRouter()
      const status = router.status()
      const snap = MemoryStore.getSnapshot()
      return {
        title: "memory status",
        output: `Backends:\n${status.map((s) => `  ${s.name}: ${s.configured ? "configured" : "not configured"} (${s.enabled ? "enabled" : "disabled"})`).join("\n")}\n\nLocal:\n  MEMORY.md: ${snap?.memoryUsage.used ?? 0}/${snap?.memoryUsage.limit ?? MEMORY_CHAR_LIMIT} chars (${snap?.memoryUsage.percent ?? 0}%)\n  USER.md: ${snap?.userUsage.used ?? 0}/${snap?.userUsage.limit ?? USER_CHAR_LIMIT} chars (${snap?.userUsage.percent ?? 0}%)`,
        metadata: { status, snapshot: snap } as Record<string, unknown>,
      }
    }

    return { title: "error", output: "Unknown action", metadata: { error: "unknown_action" } as Record<string, unknown> }
  },
})
