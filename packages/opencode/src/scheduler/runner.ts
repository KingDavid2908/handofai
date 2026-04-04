import path from "path"
import { Log } from "../util/log"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { ProviderID, ModelID } from "../provider/schema"
import { CronJobs } from "./jobs"
import { Skill } from "../skill"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"

const log = Log.create({ service: "cron.runner" })

const MODEL_FILE = path.join(Global.Path.state, "model.json")

async function getLastUsedModel(): Promise<{ providerID: ProviderID; modelID: ModelID } | null> {
  try {
    const data = await Filesystem.readJson(MODEL_FILE) as { recent?: { providerID: string; modelID: string }[] }
    const recent = data.recent
    if (recent && recent.length > 0) {
      return { providerID: recent[0].providerID as ProviderID, modelID: recent[0].modelID as ModelID }
    }
  } catch { /* ignore */ }
  return null
}

export namespace CronRunner {
  export async function run(job: CronJobs.Job): Promise<void> {
    log.info("running cron job", { jobId: job.id, name: job.name })

    const startedAt = new Date().toISOString()

    const defaultName = await Agent.defaultAgent()
    const agent = await Agent.get(defaultName)
    if (!agent) {
      log.error("no default agent found for cron job")
      await CronJobs.markCompleted(job.id, { sessionID: "", output: "error: no default agent", status: "error", error: "no default agent", startedAt })
      return
    }

    let sessionID = ""
    try {
      await CronJobs.update(job.id, { state: "running", last_run_at: startedAt })

      const model = job.model && job.provider
        ? { providerID: job.provider as ProviderID, modelID: job.model as ModelID }
        : await getLastUsedModel() ?? { providerID: agent.model?.providerID as ProviderID, modelID: agent.model?.modelID as ModelID }

      const session = await Session.create({
        title: `Cron: ${job.name ?? job.prompt.slice(0, 50)}`,
        permission: agent.permission,
      })
      sessionID = session.id

      log.info("created cron session", { sessionId: session.id, jobId: job.id, model })

      let promptText = job.prompt
      if (job.skills.length > 0) {
        const skillContexts: string[] = []
        for (const skillName of job.skills) {
          const skill = await Skill.get(skillName)
          if (skill) {
            skillContexts.push(`## Skill: ${skill.name}\n\n${skill.content}`)
          } else {
            log.warn("skill not found for cron job", { skill: skillName, jobId: job.id })
          }
        }
        if (skillContexts.length > 0) {
          promptText = skillContexts.join("\n\n") + "\n\n---\n\n" + job.prompt
        }
      }

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        model,
        agent: agent.name,
        parts: [{ type: "text", text: promptText }],
      })

      const msgs = await Session.messages({ sessionID: session.id })
      const transcript = formatTranscript(msgs)
      const text = result.parts.findLast((p) => p.type === "text")?.text ?? ""
      const preview = text.length > 200 ? text.slice(0, 200) + "..." : text

      await CronJobs.markCompleted(job.id, {
        sessionID: session.id,
        output: transcript,
        status: "success",
        startedAt,
      })
      log.info("cron job completed", { jobId: job.id, preview })

      if (job.deliver === "local") {
        log.info("cron result (local delivery)", { jobId: job.id, result: text })
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error("cron job failed", { jobId: job.id, error: errMsg })
      await CronJobs.markCompleted(job.id, {
        sessionID,
        output: `Error: ${errMsg}`,
        status: "error",
        error: errMsg,
        startedAt,
      })
    }
  }

  function formatTranscript(msgs: MessageV2.WithParts[]): string {
    const lines: string[] = []
    for (const msg of msgs) {
      const role = msg.info.role
      lines.push(`## ${role === "user" ? "User" : "Assistant"}`)
      lines.push("")
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          lines.push(part.text)
          lines.push("")
        }
        if (part.type === "tool") {
          const toolName = part.tool
          const title = "title" in part.state ? String(part.state.title || "") : ""
          const output = "output" in part.state ? String(part.state.output ?? "") : ""
          lines.push(`[Tool: ${toolName}${title ? ` — ${title}` : ""}]`)
          if (output) {
            lines.push(output)
          }
          lines.push("")
        }
      }
      lines.push("---")
      lines.push("")
    }
    return lines.join("\n")
  }
}
