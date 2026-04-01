import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./memory.txt"
import { MemoryStore } from "../memory/memory-store"

export const MemoryTool = Tool.define("memory", {
  description: DESCRIPTION,
  parameters: z.object({
    action: z.enum(["add", "replace", "remove"]).describe("Action to perform on memory."),
    target: z.enum(["memory", "user"]).describe("Which memory to modify: 'memory' for your notes, 'user' for facts about the user."),
    content: z.string().optional().describe("Content to add (for 'add') or replace with (for 'replace')."),
    old_text: z.string().optional().describe("Text to find for 'replace' or 'remove' actions."),
  }),
  async execute(params, ctx) {
    // Check if memory system is enabled
    const enabled = await MemoryStore.isEnabled()
    if (!enabled) {
      return {
        title: "error",
        output: "Memory system is disabled. The user has disabled memory in config. Do not attempt to use this tool until the user re-enables it.",
        metadata: { error: "memory_disabled" },
      }
    }

    if (!MemoryStore.isInitialized()) {
      await MemoryStore.init().catch(() => {})
      if (!MemoryStore.isInitialized()) {
        return {
          title: "error",
          output: "Memory system not initialized. Call MemoryStore.init() first.",
          metadata: { error: "not_initialized" },
        }
      }
    }

    const { action, target } = params

    if (action === "add") {
      if (!params.content) {
        return { title: "error", output: "content is required for 'add' action", metadata: { error: "missing_content" } }
      }
      const result = await MemoryStore.add(target, params.content)
      return {
        title: result.success ? `added to ${target}` : "failed",
        output: result.success
          ? `Added to ${target}.\n\nCurrent ${target} state (${result.usage}):\n${(result.entries ?? []).join("\n§\n")}`
          : `Failed: ${result.error}`,
        metadata: result.success ? { error: "", success: result.success, entries: result.entries, usage: result.usage } : { error: result.error ?? "" },
      }
    }

    if (action === "replace") {
      if (!params.content) {
        return { title: "error", output: "content is required for 'replace' action", metadata: { error: "missing_content" } }
      }
      if (!params.old_text) {
        return { title: "error", output: "old_text is required for 'replace' action", metadata: { error: "missing_old_text" } }
      }
      const result = await MemoryStore.replace(target, params.old_text, params.content)
      return {
        title: result.success ? `replaced in ${target}` : "failed",
        output: result.success
          ? `Replaced in ${target}.\n\nCurrent ${target} state (${result.usage}):\n${(result.entries ?? []).join("\n§\n")}`
          : `Failed: ${result.error}`,
        metadata: result.success ? { error: "", success: result.success, entries: result.entries, usage: result.usage } : { error: result.error ?? "" },
      }
    }

    if (action === "remove") {
      if (!params.old_text) {
        return { title: "error", output: "old_text is required for 'remove' action", metadata: { error: "missing_old_text" } }
      }
      const result = await MemoryStore.remove(target, params.old_text)
      return {
        title: result.success ? `removed from ${target}` : "failed",
        output: result.success
          ? `Removed from ${target}.\n\nCurrent ${target} state (${result.usage}):\n${(result.entries ?? []).join("\n§\n")}`
          : `Failed: ${result.error}`,
        metadata: result.success ? { error: "", success: result.success, entries: result.entries, usage: result.usage } : { error: result.error ?? "" },
      }
    }

    return { title: "error", output: "Unknown action", metadata: { error: "unknown_action" } }
  },
})
