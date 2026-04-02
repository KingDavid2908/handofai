import z from "zod"
import { Tool } from "./tool"
import { Skill } from "@/skill"
import { create, edit, patch, remove, writeFile, removeFile, type ManageResult } from "@/skill/manage"

export const SkillManageTool = Tool.define("skill_manage", async () => {
  return {
    description: `Manage skills (create, update, delete). Skills are your procedural memory.

Actions:
- create: Create new skill with SKILL.md + optional category
- edit: Replace SKILL.md content (full rewrite)
- patch: Targeted find-replace (preferred for fixes)
- delete: Remove skill entirely
- write_file: Add file to skill directory
- remove_file: Remove file from skill directory

Create when: complex task succeeded (5+ calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered.
Update when: instructions stale/wrong, OS-specific failures, missing steps found during use.
Delete when: skill is no longer relevant or fundamentally broken.

Good skills include: trigger conditions, numbered steps with exact commands, pitfalls section, verification steps.

File paths for write_file/remove_file: references/, templates/, scripts/, assets/

Security: All skills are scanned for malicious patterns. Critical findings block creation/modification.`,
    parameters: z.object({
      action: z.enum(["create", "edit", "patch", "delete", "write_file", "remove_file"])
        .describe("The action to perform"),
      name: z.string().describe("Skill name (lowercase, hyphens/underscores, max 64 chars)"),
      content: z.string().optional()
        .describe("Full SKILL.md content (YAML frontmatter + markdown body). Required for create and edit."),
      category: z.string().optional()
        .describe("Optional category for organizing skills (e.g., 'devops', 'testing'). Only for create."),
      old_string: z.string().optional()
        .describe("Text to find for patch. Must be unique unless replace_all=true."),
      new_string: z.string().optional()
        .describe("Replacement text for patch. Empty string to delete."),
      replace_all: z.boolean().optional().default(false)
        .describe("Replace all occurrences of old_string"),
      file_path: z.string().optional()
        .describe("Path within skill directory (references/, templates/, scripts/, assets/)"),
      file_content: z.string().optional()
        .describe("Content for file write"),
    }),
    async execute(params, ctx) {
      await ctx.ask({
        permission: "skill_manage",
        patterns: ["*"],
        always: ["*"],
        metadata: { action: params.action, name: params.name },
      })

      let result: ManageResult

      switch (params.action) {
        case "create":
          if (!params.content) {
            return { output: "Error: content is required for 'create'. Provide full SKILL.md text.", title: "Skill create failed", metadata: {} }
          }
          result = await create(params.name, params.content, params.category)
          break

        case "edit":
          if (!params.content) {
            return { output: "Error: content is required for 'edit'.", title: "Skill edit failed", metadata: {} }
          }
          result = await edit(params.name, params.content)
          break

        case "patch":
          result = await patch(params.name, params.old_string || "", params.new_string || "", params.file_path, params.replace_all)
          break

        case "delete":
          result = await remove(params.name)
          break

        case "write_file":
          if (!params.file_path) {
            return { output: "Error: file_path is required for write_file.", title: "Skill write failed", metadata: {} }
          }
          if (params.file_content === undefined) {
            return { output: "Error: file_content is required for write_file.", title: "Skill write failed", metadata: {} }
          }
          result = await writeFile(params.name, params.file_path, params.file_content)
          break

        case "remove_file":
          if (!params.file_path) {
            return { output: "Error: file_path is required for remove_file.", title: "Skill remove failed", metadata: {} }
          }
          result = await removeFile(params.name, params.file_path)
          break
      }

      if (!result.success) {
        let output = `Error: ${result.error}`
        if (result.scanReport) output += `\n\n${result.scanReport}`
        if (result.availableFiles) output += `\nAvailable files: ${result.availableFiles.join(", ")}`
        if (result.filePreview) output += `\n\nFile preview:\n${result.filePreview}`
        return { output, title: `Skill ${params.action} failed`, metadata: {} }
      }

      await Skill.reload()

      let output = result.message || "Success"
      if (result.hint) output += `\n\nHint: ${result.hint}`

      return { output, title: `Skill ${params.action}`, metadata: {} }
    },
  }
})
