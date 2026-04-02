import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"

export const SkillsListTool = Tool.define("skills_list", async () => {
  await Skill.reload().catch(() => {})
  const skills = await Skill.all()

  const skillLines = skills.map((s) => {
    const dir = path.dirname(s.location)
    return `  - ${s.name}: ${s.description} (${dir})`
  }).join("\n")

  return {
    description: `List all available skills with metadata.

Use this to discover existing skills before creating new ones.

Available skills:
${skillLines || "  (none)"}`,
    parameters: z.object({
      category: z.string().optional()
        .describe("Filter by category/subdirectory"),
    }),
    async execute(params) {
      await Skill.reload().catch(() => {})
      let skills = await Skill.all()

      if (params.category) {
        skills = skills.filter((s) => {
          const dir = path.dirname(s.location)
          return dir.includes(params.category!)
        })
      }

      if (skills.length === 0) {
        return { output: "No skills found.", title: "Skills list", metadata: { count: 0 } }
      }

      const lines = [
        `Found ${skills.length} skill${skills.length > 1 ? "s" : ""}:`,
        "",
        ...skills.map((s) => {
          const dir = path.dirname(s.location)
          return `- **${s.name}**: ${s.description}\n  Location: ${dir}`
        }),
      ]

      return {
        output: lines.join("\n"),
        title: `Skills list (${skills.length})`,
        metadata: { count: skills.length },
      }
    },
  }
})
