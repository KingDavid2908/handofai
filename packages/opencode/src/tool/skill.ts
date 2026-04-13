import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { Ripgrep } from "../file/ripgrep"
import { iife } from "@/util/iife"
import { Config } from "../config/config"

const DEFAULT_REGISTRIES = [
  "https://github.com/VoltAgent/awesome-agent-skills",
  "https://github.com/vercel-labs/skills",
]

export const SkillTool = Tool.define("skill", async (ctx) => {
  const list = await Skill.available(ctx?.agent)

  const description =
    list.length === 0
      ? "Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available."
      : [
          "Load a specialized skill that provides domain-specific instructions and workflows.",
          "",
          "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
          "",
          "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
          "",
          'Tool output includes a `<skill_content name="...">` block with the loaded content.',
          "",
          "The following skills provide specialized sets of instructions for particular tasks",
          "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
          "",
          Skill.fmt(list, { verbose: false }),
        ].join("\n")

  const examples = list
    .map((skill) => `'${skill.name}'`)
    .slice(0, 3)
    .join(", ")
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

  const parameters = z.object({
    name: z.string().describe(`The name of the skill to load${hint}`),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const { name } = params
      let skill = await Skill.get(name)

      if (!skill) {
        const cfg = await Config.get()
        const urls = cfg.skills?.urls?.length ? cfg.skills.urls : DEFAULT_REGISTRIES

        for (const url of urls) {
          const fetched = await fetchRemoteSkill(url, name)
          if (fetched) {
            skill = await Skill.get(name)
            if (skill) break
          }
        }
      }

      if (!skill) {
        const skillName = name
        const msg = `Skill "${skillName}" not found locally or in remote registries (VoltAgent, Vercel).`
        const hint = `To create this skill, use skill_manage({ action: "create", name: "${skillName}", content: "..." })`
        return {
          title: `Skill: ${skillName}`,
          output: `<skill_content name="${skillName}">\n${msg}\n\n${hint}\n</skill_content>`,
          metadata: { name: skillName },
        }
      }

      await ctx.ask({
        permission: "skill",
        patterns: [name],
        always: [name],
        metadata: {},
      })

      const dir = path.dirname(skill.location)
      const base = pathToFileURL(dir).href

      const limit = 10
      const files = await iife(async () => {
        const arr = []
        for await (const file of Ripgrep.files({
          cwd: dir,
          follow: false,
          hidden: true,
          signal: ctx.abort,
        })) {
          if (file.includes("SKILL.md")) {
            continue
          }
          arr.push(path.resolve(dir, file))
          if (arr.length >= limit) {
            break
          }
        }
        return arr
      }).then((f) => f.map((file) => `<file>${file}</file>`).join("\n"))

      return {
        title: `Loaded skill: ${skill.name}`,
        output: [
          `<skill_content name="${skill.name}">`,
          `# Skill: ${skill.name}`,
          "",
          skill.content.trim(),
          "",
          `Base directory: ${base}`,
          "",
          "<skill_files>",
          files,
          "</skill_files>",
          "</skill_content>",
        ].join("\n"),
        metadata: { name: skill.name },
      }
    },
  }
})

async function fetchRemoteSkill(
  registryUrl: string,
  skillName: string
): Promise<boolean> {
  const url = `${registryUrl.replace(/\/$/, "")}/skills/${skillName}/SKILL.md`
  try {
    const res = await fetch(url)
    if (!res.ok) return false

    const text = await res.text()
    if (!text.startsWith("---")) return false

    const homeDir = process.env.HOME || ""
    const cacheDir = path.join(homeDir, ".cache/opencode/skills/remote", skillName)
    const fs = await import("fs/promises")

    try {
      await fs.mkdir(cacheDir, { recursive: true })
      await fs.writeFile(path.join(cacheDir, "SKILL.md"), text)
      return true
    } catch {
      return false
    }
  } catch {
    return false
  }
}