import z from "zod"
import { Tool } from "./tool"
import { CronJobs } from "../scheduler/jobs"
import { CronScheduler } from "../scheduler"
import { CronRunner } from "../scheduler/runner"
import { Global } from "../global"
import path from "path"

const CRON_OUTPUT_FILE = path.join(Global.Path.state, "cronjobs.json")

const CRON_THREAT_PATTERNS = [
  /ignore\s+(?:\w+\s+)*(?:previous|all|above|prior)\s+(?:\w+\s+)*instructions/i,
  /do\s+not\s+tell\s+the\s+user/i,
  /system\s+prompt\s+override/i,
  /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
  /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i,
  /authorized_keys/i,
  /\/etc\/sudoers|visudo/i,
  /rm\s+-rf\s+\//i,
]

function scanPrompt(prompt: string): string | null {
  for (const char of ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e"]) {
    if (prompt.includes(char)) {
      return `Blocked: prompt contains invisible unicode U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} (possible injection).`
    }
  }
  for (const [pattern, pid] of CRON_THREAT_PATTERNS.map((p) => [p, p.source.slice(0, 30)] as [RegExp, string])) {
    if (pattern.test(prompt)) {
      return `Blocked: prompt matches threat pattern '${pid}'. Cron prompts must not contain injection or exfiltration payloads.`
    }
  }
  return null
}

function repeatDisplay(job: CronJobs.Job): string {
  const times = job.repeat
  const completed = job.completed
  if (times === null) return "forever"
  if (times === 1) return completed === 0 ? "once" : "1/1"
  return completed ? `${completed}/${times}` : `${times} times`
}

function formatJob(job: CronJobs.Job) {
  return {
    job_id: job.id,
    name: job.name,
    skill: job.skill,
    skills: job.skills,
    prompt_preview: job.prompt.length > 100 ? job.prompt.slice(0, 100) + "..." : job.prompt,
    model: job.model,
    provider: job.provider,
    base_url: job.base_url,
    schedule: job.schedule_display,
    repeat: repeatDisplay(job),
    deliver: job.deliver,
    next_run_at: job.next_run_at,
    last_run_at: job.last_run_at,
    last_status: job.last_status,
    enabled: job.enabled,
    state: job.state,
    paused_at: job.paused_at,
    paused_reason: job.paused_reason,
  }
}

export const CronjobTool = Tool.define("cronjob", {
  description: `Manage scheduled cron jobs with a single compressed tool.

Use action='create' to schedule a new job from a prompt or one or more skills.
Use action='list' to inspect jobs.
Use action='output' to view the full transcript of a job's latest run (or a specific run_id).
Use action='update', 'pause', 'resume', 'remove', or 'run' to manage an existing job.

Jobs run in a fresh session with no current-chat context, so prompts must be self-contained.
If skill or skills are provided on create, the future cron run loads those skills in order, then follows the prompt as the task instruction.
On update, passing skills=[] clears attached skills.

Full output transcripts are stored in ${CRON_OUTPUT_FILE}.
View in TUI with /cron command, or via cronjob action='output'.
Always tell users the output file path (${CRON_OUTPUT_FILE}) when they ask about cron job results.

NOTE: The agent's final response is auto-delivered to the target. Put the primary
user-facing content in the final response. Cron jobs run autonomously with no user
present — they cannot ask questions or request clarification.`,
  parameters: z.object({
    action: z.enum(["create", "list", "update", "pause", "resume", "remove", "run", "output"])
      .describe("One of: create, list, update, pause, resume, remove, run, output"),
    job_id: z.string().optional()
      .describe("Required for update/pause/resume/remove/run/output"),
    prompt: z.string().optional()
      .describe("For create: the full self-contained prompt. If skill or skills are also provided, this becomes the task instruction paired with those skills."),
    schedule: z.string().optional()
      .describe("For create/update: '30m', 'every 2h', '0 9 * * *', or ISO timestamp"),
    name: z.string().optional()
      .describe("Optional human-friendly name"),
    repeat: z.number().optional()
      .describe("Optional repeat count. Omit for defaults (once for one-shot, forever for recurring)."),
    deliver: z.string().optional()
      .describe("Delivery target: origin, local, telegram, discord, slack, whatsapp, signal, matrix, mattermost, homeassistant, dingtalk, feishu, wecom, email, sms"),
    include_disabled: z.boolean().optional()
      .describe("For list: include paused/completed jobs"),
    skill: z.string().optional()
      .describe("Optional single skill name to load before executing the cron prompt"),
    skills: z.array(z.string()).optional()
      .describe("Optional ordered list of skills to load before executing the cron prompt. On update, pass an empty array to clear attached skills."),
    model: z.string().optional()
      .describe("Optional per-job model override used when the cron job runs"),
    provider: z.string().optional()
      .describe("Optional per-job provider override used when resolving runtime credentials"),
    base_url: z.string().optional()
      .describe("Optional per-job base URL override paired with provider/model routing"),
    reason: z.string().optional()
      .describe("Optional pause reason"),
    run_id: z.string().optional()
      .describe("For output: specific run ID. Omit to get latest run."),
  }),
  async execute(params) {
    const action = (params.action ?? "").trim().toLowerCase()

    if (action === "create") {
      if (!params.schedule) {
        return { title: "error", output: JSON.stringify({ success: false, error: "schedule is required for create" }, null, 2), metadata: {} }
      }
      const skills: string[] = params.skills ?? (params.skill ? [params.skill] : [])
      if (!params.prompt && skills.length === 0) {
        return { title: "error", output: JSON.stringify({ success: false, error: "create requires either prompt or at least one skill" }, null, 2), metadata: {} }
      }
      if (params.prompt) {
        const scanError = scanPrompt(params.prompt)
        if (scanError) {
          return { title: "error", output: JSON.stringify({ success: false, error: scanError }, null, 2), metadata: {} }
        }
      }

      const job = await CronJobs.create({
        prompt: params.prompt ?? "",
        schedule: params.schedule,
        name: params.name,
        repeat: params.repeat,
        deliver: params.deliver,
        skills,
        model: params.model ?? undefined,
        provider: params.provider ?? undefined,
        base_url: params.base_url?.replace(/\/+$/, "") ?? undefined,
      })

      CronScheduler.schedule(job)

      return {
        title: `Cron job '${job.name ?? job.id}' created`,
        output: JSON.stringify({
          success: true,
          job_id: job.id,
          name: job.name,
          skill: job.skill,
          skills: job.skills,
          schedule: job.schedule_display,
          repeat: repeatDisplay(job),
          deliver: job.deliver,
          next_run_at: job.next_run_at,
          job: formatJob(job),
          output_location: CRON_OUTPUT_FILE,
          message: `Cron job '${job.name ?? job.id}' created. Full output stored in ${CRON_OUTPUT_FILE}. View with /cron or cronjob action='output'.`,
        }, null, 2),
        metadata: {},
      }
    }

    if (action === "list") {
      const jobs = await CronJobs.list(params.include_disabled ?? false)
      const formatted = jobs.map(formatJob)
      return {
        title: `Cron jobs (${formatted.length})`,
        output: JSON.stringify({ success: true, count: formatted.length, jobs: formatted }, null, 2),
        metadata: {},
      }
    }

    if (!params.job_id) {
      return { title: "error", output: JSON.stringify({ success: false, error: `job_id is required for action '${action}'` }, null, 2), metadata: {} }
    }

    const job = await CronJobs.get(params.job_id)
    if (!job) {
      return { title: "error", output: JSON.stringify({ success: false, error: `Job with ID '${params.job_id}' not found. Use cronjob(action='list') to inspect jobs.` }, null, 2), metadata: {} }
    }

    if (action === "remove") {
      const removed = await CronJobs.remove(params.job_id)
      if (!removed) {
        return { title: "error", output: JSON.stringify({ success: false, error: `Failed to remove job '${params.job_id}'` }, null, 2), metadata: {} }
      }
      CronScheduler.stop(params.job_id)
      return {
        title: `Cron job '${job.name ?? job.id}' removed`,
        output: JSON.stringify({
          success: true,
          message: `Cron job '${job.name ?? job.id}' removed.`,
          removed_job: { id: params.job_id, name: job.name, schedule: job.schedule_display },
        }, null, 2),
        metadata: {},
      }
    }

    if (action === "pause") {
      const updated = await CronJobs.pause(params.job_id, params.reason)
      CronScheduler.pause(params.job_id)
      return { title: `Cron job '${updated.name ?? updated.id}' paused`, output: JSON.stringify({ success: true, job: formatJob(updated) }, null, 2), metadata: {} }
    }

    if (action === "resume") {
      const updated = await CronJobs.resume(params.job_id)
      CronScheduler.resume(updated)
      return { title: `Cron job '${updated.name ?? updated.id}' resumed`, output: JSON.stringify({ success: true, job: formatJob(updated) }, null, 2), metadata: {} }
    }

    if (action === "run" || action === "run_now" || action === "trigger") {
      await CronRunner.run(job)
      const refreshed = await CronJobs.get(params.job_id)
      return { title: `Cron job '${refreshed?.name ?? job.id}' triggered`, output: JSON.stringify({ success: true, job: refreshed ? formatJob(refreshed) : null, output_location: CRON_OUTPUT_FILE, message: `Job executed. Full output stored in ${CRON_OUTPUT_FILE}. View with /cron or cronjob action='output'.` }, null, 2), metadata: {} }
    }

    if (action === "update") {
      const updates: Partial<CronJobs.Job> = {}
      if (params.prompt !== undefined) {
        const scanError = scanPrompt(params.prompt)
        if (scanError) {
          return { title: "error", output: JSON.stringify({ success: false, error: scanError }, null, 2), metadata: {} }
        }
        updates.prompt = params.prompt
      }
      if (params.name !== undefined) updates.name = params.name
      if (params.deliver !== undefined) updates.deliver = params.deliver
      if (params.skills !== undefined || params.skill !== undefined) {
        const canonical: string[] = params.skills ?? (params.skill ? [params.skill] : [])
        updates.skills = canonical
        updates.skill = canonical[0] ?? undefined
      }
      if (params.model !== undefined) updates.model = params.model
      if (params.provider !== undefined) updates.provider = params.provider
      if (params.base_url !== undefined) updates.base_url = params.base_url.replace(/\/+$/, "")
      if (params.repeat !== undefined) {
        updates.repeat = params.repeat <= 0 ? undefined : params.repeat
      }
      if (params.schedule !== undefined) {
        const parsed = CronJobs.parseSchedule(params.schedule)
        updates.schedule = parsed.cron
        updates.schedule_display = parsed.display
        if (job.state !== "paused") {
          updates.state = "scheduled"
          updates.enabled = true
        }
      }

      if (Object.keys(updates).length === 0) {
        return { title: "error", output: JSON.stringify({ success: false, error: "No updates provided." }, null, 2), metadata: {} }
      }

      const updated = await CronJobs.update(params.job_id, updates)
      if (updated.enabled && updated.state === "scheduled") {
        CronScheduler.schedule(updated)
      } else {
        CronScheduler.stop(params.job_id)
      }
      return { title: `Cron job '${updated.name ?? updated.id}' updated`, output: JSON.stringify({ success: true, job: formatJob(updated) }, null, 2), metadata: {} }
    }

    if (action === "output") {
      const result = await CronJobs.getOutput(params.job_id, params.run_id)
      if (!result) {
        return { title: "error", output: JSON.stringify({ success: false, error: `Job with ID '${params.job_id}' not found.` }, null, 2), metadata: {} }
      }
      if (result.records.length === 0) {
        return { title: "no runs", output: JSON.stringify({ success: true, message: "No run history for this job." }, null, 2), metadata: {} }
      }
      const target = result.latest
      if (!target) {
        return { title: "error", output: JSON.stringify({ success: false, error: "No output found." }, null, 2), metadata: {} }
      }
      const runSummary = result.records.map((r, i) => ({
        run: i + 1,
        id: r.id,
        session_id: r.session_id,
        started_at: r.started_at,
        finished_at: r.finished_at,
        status: r.status,
        preview: r.output.slice(0, 100) + (r.output.length > 100 ? "..." : ""),
      }))
      return {
        title: `Cron output: ${target.status}`,
        output: JSON.stringify({
          success: true,
          job_id: params.job_id,
          run_id: target.id,
          session_id: target.session_id,
          started_at: target.started_at,
          finished_at: target.finished_at,
          status: target.status,
          error: target.error,
          run_history: runSummary,
          output_location: CRON_OUTPUT_FILE,
          output: target.output,
        }, null, 2),
        metadata: {},
      }
    }

    return { title: "error", output: JSON.stringify({ success: false, error: `Unknown cron action '${params.action}'` }, null, 2), metadata: {} }
  },
})
