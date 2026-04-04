import type { ScheduledTask } from "node-cron"
import cron from "node-cron"
import { Log } from "../util/log"
import { CronJobs } from "./jobs"
import { CronRunner } from "./runner"

const log = Log.create({ service: "cron.scheduler" })

export namespace CronScheduler {
  const tasks = new Map<string, ScheduledTask>()

  export async function start() {
    const jobs = await CronJobs.list(true)
    log.info("starting scheduler", { jobCount: jobs.length })

    for (const job of jobs) {
      if (job.enabled && job.state === "scheduled") {
        schedule(job)
      }
    }
  }

  export function schedule(job: CronJobs.Job) {
    if (tasks.has(job.id)) {
      const existing = tasks.get(job.id)!
      existing.stop()
      tasks.delete(job.id)
    }

    try {
      const task = cron.schedule(job.schedule, async () => {
        log.info("cron trigger", { jobId: job.id, name: job.name })
        await CronRunner.run(job)
      }, {
        scheduled: true,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })

      tasks.set(job.id, task)
      log.info("scheduled job", { jobId: job.id, schedule: job.schedule_display })
    } catch (err) {
      log.error("failed to schedule job", { jobId: job.id, error: err })
    }
  }

  export function stop(id: string) {
    const task = tasks.get(id)
    if (task) {
      task.stop()
      tasks.delete(id)
      log.info("stopped job", { jobId: id })
    }
  }

  export function pause(id: string) {
    const task = tasks.get(id)
    if (task) {
      task.stop()
      log.info("paused job", { jobId: id })
    }
  }

  export function resume(job: CronJobs.Job) {
    schedule(job)
  }

  export function stopAll() {
    for (const [id, task] of tasks) {
      task.stop()
    }
    tasks.clear()
    log.info("all cron jobs stopped")
  }
}
