import z from "zod"
import { Tool } from "./tool"
import { LessonStore } from "../lessons/lesson-store"

export const LessonTool = Tool.define("lesson", {
  description: `Save lessons from this session. Capture what went wrong, what the user corrected, and how to avoid repeating mistakes.

Actions:
- add: Add a new lesson
- replace: Replace an existing lesson (find by old_text, replace with new content)
- remove: Remove a lesson (find by old_text)

Save lessons when: the user corrects your approach, a tool fails and you find a workaround, or you discover a non-obvious pattern.
Keep lessons concise: describe the mistake, the correction, and the better approach.

IMPORTANT: Before adding a lesson, check existing lessons first to avoid duplicates.
Use replace to update an existing lesson rather than adding a duplicate.`,
  parameters: z.object({
    action: z.enum(["add", "replace", "remove"]).describe("Action to perform on lessons."),
    content: z.string().optional().describe("Content to add (for 'add') or replace with (for 'replace')."),
    old_text: z.string().optional().describe("Text to find for 'replace' or 'remove' actions."),
  }),
  async execute(params, ctx) {
    if (!LessonStore.isInitialized()) {
      await LessonStore.init().catch(() => {})
      if (!LessonStore.isInitialized()) {
        return {
          title: "error",
          output: "Lesson system not initialized. Call LessonStore.init() first.",
          metadata: { error: "not_initialized" },
        }
      }
    }

    const { action } = params

    if (action === "add") {
      if (!params.content) {
        return { title: "error", output: "content is required for 'add' action", metadata: { error: "missing_content" } }
      }
      const result = await LessonStore.add(params.content)
      return {
        title: result.success ? "added to lessons" : "failed",
        output: result.success
          ? `Added to lessons.\n\nCurrent lessons state (${result.usage}):\n${(result.entries ?? []).join("\n§\n")}`
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
      const result = await LessonStore.replace(params.old_text, params.content)
      return {
        title: result.success ? "replaced in lessons" : "failed",
        output: result.success
          ? `Replaced in lessons.\n\nCurrent lessons state (${result.usage}):\n${(result.entries ?? []).join("\n§\n")}`
          : `Failed: ${result.error}`,
        metadata: result.success ? { error: "", success: result.success, entries: result.entries, usage: result.usage } : { error: result.error ?? "" },
      }
    }

    if (action === "remove") {
      if (!params.old_text) {
        return { title: "error", output: "old_text is required for 'remove' action", metadata: { error: "missing_old_text" } }
      }
      const result = await LessonStore.remove(params.old_text)
      return {
        title: result.success ? "removed from lessons" : "failed",
        output: result.success
          ? `Removed from lessons.\n\nCurrent lessons state (${result.usage}):\n${(result.entries ?? []).join("\n§\n")}`
          : `Failed: ${result.error}`,
        metadata: result.success ? { error: "", success: result.success, entries: result.entries, usage: result.usage } : { error: result.error ?? "" },
      }
    }

    return { title: "error", output: "Unknown action", metadata: { error: "unknown_action" } }
  },
})
