import path from "path"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { ulid } from "ulid"
import cron from "node-cron"

export namespace CronJobs {
  const JOBS_FILE = path.join(Global.Path.state, "cronjobs.json")

  export interface RunRecord {
    id: string
    session_id: string
    started_at: string
    finished_at: string
    status: "success" | "error"
    output: string
    error: string | undefined
  }

  export interface Job {
    id: string
    name: string | undefined
    prompt: string
    schedule: string
    schedule_display: string
    repeat: number | undefined
    completed: number
    deliver: string
    skill: string | undefined
    skills: string[]
    model: string | undefined
    provider: string | undefined
    base_url: string | undefined
    enabled: boolean
    state: "scheduled" | "paused" | "completed" | "running"
    created_at: string
    next_run_at: string | undefined
    last_run_at: string | undefined
    last_status: string | undefined
    paused_at: string | undefined
    paused_reason: string | undefined
    origin: { platform: string; chat_id: string; chat_name?: string; thread_id?: string } | undefined
    history: RunRecord[]
  }

  let _cache: Job[] | null = null

  async function load(): Promise<Job[]> {
    if (_cache) return _cache
    try {
      const raw = await Filesystem.readJson(JOBS_FILE) as { jobs?: Job[] }
      _cache = (raw.jobs ?? []).map((j) => ({
        ...j,
        history: j.history ?? [],
      }))
    } catch {
      _cache = []
    }
    return _cache
  }

  async function save(jobs: Job[]) {
    _cache = jobs
    await Filesystem.writeJson(JOBS_FILE, { jobs })
  }

  function invalidate() {
    _cache = null
  }

  export function parseSchedule(input: string): { cron: string; display: string } {
    const trimmed = input.trim()

    // Already a cron expression
    if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(trimmed)) {
      return { cron: trimmed, display: trimmed }
    }

    // ISO timestamp (one-shot)
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const date = new Date(trimmed)
      const cronExpr = `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`
      return { cron: cronExpr, display: `at ${trimmed}` }
    }

    // Natural language parsing
    const lower = trimmed.toLowerCase()

    // "every Xh" or "every X hours"
    const hourlyMatch = lower.match(/^every\s+(\d+)\s*(h|hr|hrs|hours?)$/)
    if (hourlyMatch) {
      const hours = parseInt(hourlyMatch[1])
      return { cron: `0 */${hours} * * *`, display: `every ${hours}h` }
    }

    // "every Xm" or "every X minutes"
    const minuteMatch = lower.match(/^every\s+(\d+)\s*(m|min|mins|minutes?)$/)
    if (minuteMatch) {
      const minutes = parseInt(minuteMatch[1])
      return { cron: `*/${minutes} * * * *`, display: `every ${minutes}m` }
    }

    // "every Xd" or "every X days"
    const dayMatch = lower.match(/^every\s+(\d+)\s*(d|day|days?)$/)
    if (dayMatch) {
      const days = parseInt(dayMatch[1])
      return { cron: `0 0 */${days} * *`, display: `every ${days}d` }
    }

    // "Xm" or "X minutes" (interval from now — treated as recurring)
    const simpleMinute = lower.match(/^(\d+)\s*(m|min|mins|minutes?)$/)
    if (simpleMinute) {
      const minutes = parseInt(simpleMinute[1])
      return { cron: `*/${minutes} * * * *`, display: `every ${minutes}m` }
    }

    // "Xh" (interval from now — treated as recurring)
    const simpleHour = lower.match(/^(\d+)\s*(h|hr|hrs|hours?)$/)
    if (simpleHour) {
      const hours = parseInt(simpleHour[1])
      return { cron: `0 */${hours} * * *`, display: `every ${hours}h` }
    }

    // "daily at X:XXam/pm"
    const dailyMatch = lower.match(/^daily\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)$/)
    if (dailyMatch) {
      let hours = parseInt(dailyMatch[1])
      const minutes = parseInt(dailyMatch[2])
      const ampm = dailyMatch[3]
      if (ampm === "pm" && hours !== 12) hours += 12
      if (ampm === "am" && hours === 12) hours = 0
      return { cron: `${minutes} ${hours} * * *`, display: `daily at ${dailyMatch[1]}:${dailyMatch[2]}${ampm}` }
    }

    // "daily"
    if (lower === "daily" || lower === "every day") {
      return { cron: "0 9 * * *", display: "daily at 9:00am" }
    }

    // "weekly"
    if (lower === "weekly" || lower === "every week") {
      return { cron: "0 9 * * 1", display: "weekly on Monday at 9:00am" }
    }

    // "monthly"
    if (lower === "monthly" || lower === "every month") {
      return { cron: "0 9 1 * *", display: "monthly on the 1st at 9:00am" }
    }

    throw new Error(`Cannot parse schedule: "${input}". Use cron format (e.g. "0 9 * * *") or natural language (e.g. "every 2h", "daily at 9am").`)
  }

  export function calcNextRun(schedule: string): string | undefined {
    if (!cron.validate(schedule)) return undefined
    try {
      const task = cron.schedule(schedule, () => {}, { scheduled: false })
      task.start()
      const next = new Date(Date.now() + 60_000)
      task.stop()
      return next.toISOString()
    } catch {
      return undefined
    }
  }

  export async function list(includeDisabled = false): Promise<Job[]> {
    const jobs = await load()
    return includeDisabled ? jobs : jobs.filter((j) => j.enabled)
  }

  export async function get(id: string): Promise<Job | null> {
    const jobs = await load()
    return jobs.find((j) => j.id === id) ?? null
  }

  export async function create(input: {
    prompt: string
    schedule: string
    name?: string
    repeat?: number
    deliver?: string
    skill?: string
    skills?: string[]
    model?: string
    provider?: string
    base_url?: string
    origin?: { platform: string; chat_id: string; chat_name?: string; thread_id?: string }
  }): Promise<Job> {
    const jobs = await load()
    const parsed = parseSchedule(input.schedule)
    const skills = normalizeSkills(input.skill, input.skills)
    const id = ulid()
    const now = new Date().toISOString()

    const job: Job = {
      id,
      name: input.name ?? undefined,
      prompt: input.prompt,
      schedule: parsed.cron,
      schedule_display: parsed.display,
      repeat: input.repeat ?? undefined,
      completed: 0,
      deliver: input.deliver ?? "local",
      skill: skills[0] ?? undefined,
      skills,
      model: input.model ?? undefined,
      provider: input.provider ?? undefined,
      base_url: input.base_url ?? undefined,
      enabled: true,
      state: "scheduled",
      created_at: now,
      next_run_at: calcNextRun(parsed.cron),
      last_run_at: undefined,
      last_status: undefined,
      paused_at: undefined,
      paused_reason: undefined,
      origin: input.origin ?? undefined,
      history: [],
    }

    jobs.push(job)
    await save(jobs)
    return job
  }

  export async function update(id: string, updates: Partial<Job>): Promise<Job> {
    const jobs = await load()
    const idx = jobs.findIndex((j) => j.id === id)
    if (idx < 0) throw new Error(`Job '${id}' not found`)

    const job = { ...jobs[idx], ...updates }
    jobs[idx] = job
    await save(jobs)
    return job
  }

  export async function pause(id: string, reason?: string): Promise<Job> {
    return update(id, {
      enabled: false,
      state: "paused",
      paused_at: new Date().toISOString(),
      paused_reason: reason ?? undefined,
    })
  }

  export async function resume(id: string): Promise<Job> {
    const job = await update(id, {
      enabled: true,
      state: "scheduled",
      paused_at: undefined,
      paused_reason: undefined,
    })
    job.next_run_at = calcNextRun(job.schedule)
    await save((await load()).map((j) => j.id === job.id ? job : j))
    return job
  }

  export async function remove(id: string): Promise<boolean> {
    const jobs = await load()
    const idx = jobs.findIndex((j) => j.id === id)
    if (idx < 0) return false
    jobs.splice(idx, 1)
    await save(jobs)
    return true
  }

  export async function trigger(id: string): Promise<Job> {
    return update(id, {
      state: "running",
      last_run_at: new Date().toISOString(),
    })
  }

  export async function markCompleted(id: string, input: { sessionID: string; output: string; status: "success" | "error"; error?: string; startedAt: string }): Promise<Job> {
    const jobs = await load()
    const job = jobs.find((j) => j.id === id)
    if (!job) throw new Error(`Job '${id}' not found`)

    const finishedAt = new Date().toISOString()
    const preview = input.output.length > 200 ? input.output.slice(0, 200) + "..." : input.output

    job.last_status = preview
    job.last_run_at = finishedAt
    job.state = "scheduled"

    const record: RunRecord = {
      id: ulid(),
      session_id: input.sessionID,
      started_at: input.startedAt,
      finished_at: finishedAt,
      status: input.status,
      output: input.output,
      error: input.error,
    }
    job.history.push(record)

    if (job.repeat !== undefined) {
      job.completed++
      if (job.completed >= job.repeat) {
        job.enabled = false
        job.state = "completed"
      }
    }

    job.next_run_at = job.enabled ? calcNextRun(job.schedule) : undefined
    await save(jobs)
    return job
  }

  export async function getOutput(jobId: string, runId?: string): Promise<{ job: Job; records: RunRecord[]; latest: RunRecord | undefined } | null> {
    const job = await get(jobId)
    if (!job) return null
    const records = [...job.history].reverse()
    const latest = records[0]
    if (runId) {
      const match = job.history.find((r) => r.id === runId)
      return { job, records, latest: match }
    }
    return { job, records, latest }
  }

  function normalizeSkills(skill?: string, skills?: string[]): string[] {
    const raw: string[] = skills ?? (skill ? [skill] : [])
    const normalized: string[] = []
    for (const item of raw) {
      const text = (item ?? "").trim()
      if (text && !normalized.includes(text)) normalized.push(text)
    }
    return normalized
  }
}
