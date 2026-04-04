import type { Argv } from "yargs"
import { UI } from "../ui"
import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { CronJobs } from "../../scheduler/jobs"
import { CronScheduler } from "../../scheduler"

export const CronCommand = cmd({
  command: "cron [action]",
  describe: "manage scheduled cron jobs",
  builder: (yargs: Argv) => {
    return yargs
      .positional("action", {
        describe: "Action: create, list, remove, pause, resume, run, output, history",
        type: "string",
      })
      .option("schedule", {
        alias: "s",
        describe: "Schedule: '30m', 'every 2h', '0 9 * * *', or ISO timestamp",
        type: "string",
      })
      .option("prompt", {
        alias: "p",
        describe: "Prompt to run on schedule",
        type: "string",
      })
      .option("name", {
        alias: "n",
        describe: "Human-friendly name for the job",
        type: "string",
      })
      .option("job-id", {
        alias: "j",
        describe: "Job ID (for remove/pause/resume/run/output/history)",
        type: "string",
      })
      .option("run-id", {
        describe: "Run ID (for output: specific run, omit for latest)",
        type: "string",
      })
      .option("repeat", {
        alias: "r",
        describe: "Number of times to repeat",
        type: "number",
      })
      .option("deliver", {
        alias: "d",
        describe: "Delivery target (local, telegram, discord, etc.)",
        type: "string",
      })
      .option("skill", {
        describe: "Skill to load before executing",
        type: "string",
      })
      .option("model", {
        describe: "Per-job model override",
        type: "string",
      })
      .option("provider", {
        describe: "Per-job provider override",
        type: "string",
      })
      .option("include-disabled", {
        describe: "Include paused/completed jobs in list",
        type: "boolean",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const action = args.action ?? "list"

      if (action === "list") {
        const jobs = await CronJobs.list(args.includeDisabled ?? false)
        if (jobs.length === 0) {
          UI.println(UI.Style.TEXT_NORMAL + "No scheduled cron jobs." + UI.Style.TEXT_NORMAL)
          return
        }

        UI.println(UI.Style.TEXT_NORMAL_BOLD + `Cron Jobs (${jobs.length}):` + UI.Style.TEXT_NORMAL)
        UI.println("")

        for (const job of jobs) {
          const state = job.enabled ? job.state : "paused"
          const status = state === "scheduled" ? "scheduled" : state === "running" ? "running" : state === "completed" ? "completed" : "paused"
          const runCount = job.history.length
          UI.println(UI.Style.TEXT_NORMAL_BOLD + `  [${status}] ${job.name ?? job.id} (${job.id})` + UI.Style.TEXT_NORMAL)
          UI.println(`    Schedule: ${job.schedule_display}`)
          if (job.next_run_at) UI.println(`    Next run: ${job.next_run_at}`)
          if (job.last_run_at) UI.println(`    Last run: ${job.last_run_at}`)
          if (job.last_status) UI.println(`    Last status: ${job.last_status}`)
          UI.println(`    Runs: ${runCount}`)
          UI.println(`    Prompt: ${job.prompt.slice(0, 80)}${job.prompt.length > 80 ? "..." : ""}`)
          UI.println("")
        }
        return
      }

      if (action === "create") {
        if (!args.schedule) {
          UI.error("--schedule is required for create")
          return
        }
        if (!args.prompt) {
          UI.error("--prompt is required for create")
          return
        }

        const job = await CronJobs.create({
          prompt: args.prompt,
          schedule: args.schedule,
          name: args.name,
          repeat: args.repeat,
          deliver: args.deliver,
          skill: args.skill,
          model: args.model,
          provider: args.provider,
        })

        CronScheduler.schedule(job)

        UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Cron job '${job.name ?? job.id}' created` + UI.Style.TEXT_SUCCESS)
        UI.println(`  ID: ${job.id}`)
        UI.println(`  Schedule: ${job.schedule_display}`)
        if (job.next_run_at) UI.println(`  Next run: ${job.next_run_at}`)
        return
      }

      if (action === "remove") {
        if (!args.jobId) {
          UI.error("--job-id is required for remove")
          return
        }
        const job = await CronJobs.get(args.jobId)
        if (!job) {
          UI.error(`Job '${args.jobId}' not found`)
          return
        }
        CronScheduler.stop(args.jobId)
        await CronJobs.remove(args.jobId)
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Cron job '${job.name ?? job.id}' removed` + UI.Style.TEXT_SUCCESS)
        return
      }

      if (action === "pause") {
        if (!args.jobId) {
          UI.error("--job-id is required for pause")
          return
        }
        const job = await CronJobs.get(args.jobId)
        if (!job) {
          UI.error(`Job '${args.jobId}' not found`)
          return
        }
        CronScheduler.pause(args.jobId)
        await CronJobs.pause(args.jobId)
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Cron job '${job.name ?? job.id}' paused` + UI.Style.TEXT_SUCCESS)
        return
      }

      if (action === "resume") {
        if (!args.jobId) {
          UI.error("--job-id is required for resume")
          return
        }
        const job = await CronJobs.get(args.jobId)
        if (!job) {
          UI.error(`Job '${args.jobId}' not found`)
          return
        }
        const updated = await CronJobs.resume(args.jobId)
        CronScheduler.resume(updated)
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Cron job '${updated.name ?? updated.id}' resumed` + UI.Style.TEXT_SUCCESS)
        return
      }

      if (action === "run") {
        if (!args.jobId) {
          UI.error("--job-id is required for run")
          return
        }
        const job = await CronJobs.get(args.jobId)
        if (!job) {
          UI.error(`Job '${args.jobId}' not found`)
          return
        }
        UI.println(UI.Style.TEXT_NORMAL + `Running job '${job.name ?? job.id}'...` + UI.Style.TEXT_NORMAL)
        const { CronRunner } = await import("../../scheduler/runner")
        await CronRunner.run(job)
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Job executed" + UI.Style.TEXT_SUCCESS)
        return
      }

      if (action === "output") {
        if (!args.jobId) {
          UI.error("--job-id is required for output")
          return
        }
        const result = await CronJobs.getOutput(args.jobId, args.runId)
        if (!result) {
          UI.error(`Job '${args.jobId}' not found`)
          return
        }
        if (result.records.length === 0) {
          UI.println(UI.Style.TEXT_NORMAL + "No run history for this job." + UI.Style.TEXT_NORMAL)
          return
        }
        const target = result.latest
        if (!target) {
          UI.error("No output found.")
          return
        }
        UI.println(UI.Style.TEXT_NORMAL_BOLD + `Job: ${args.jobId} → Run: ${target.id}` + UI.Style.TEXT_NORMAL)
        UI.println(`  Session: ${target.session_id || "(none)"}`)
        UI.println(`  Started: ${target.started_at}`)
        UI.println(`  Finished: ${target.finished_at}`)
        UI.println(`  Status: ${target.status}`)
        if (target.error) UI.println(`  Error: ${target.error}`)
        UI.println("")
        UI.println(UI.Style.TEXT_NORMAL_BOLD + "Output:" + UI.Style.TEXT_NORMAL)
        const assistantBlocks = target.output.split("\n## Assistant\n")
        const lastBlock = assistantBlocks[assistantBlocks.length - 1]
        const cleanOutput = lastBlock
          .split("\n")
          .filter((line) => !line.startsWith("[Tool:"))
          .join("\n")
          .trim()
        UI.println(cleanOutput || target.output)
        return
      }

      if (action === "history") {
        if (!args.jobId) {
          UI.error("--job-id is required for history")
          return
        }
        const result = await CronJobs.getOutput(args.jobId)
        if (!result) {
          UI.error(`Job '${args.jobId}' not found`)
          return
        }
        if (result.records.length === 0) {
          UI.println(UI.Style.TEXT_NORMAL + "No run history for this job." + UI.Style.TEXT_NORMAL)
          return
        }
        UI.println(UI.Style.TEXT_NORMAL_BOLD + `Job: ${args.jobId} — Run History (${result.records.length} runs):` + UI.Style.TEXT_NORMAL)
        UI.println("")
        for (let i = 0; i < result.records.length; i++) {
          const r = result.records[i]
          UI.println(UI.Style.TEXT_NORMAL_BOLD + `  Run ${i + 1}: ${r.id}` + UI.Style.TEXT_NORMAL)
          UI.println(`    Session: ${r.session_id || "(none)"}`)
          UI.println(`    Started: ${r.started_at}`)
          UI.println(`    Finished: ${r.finished_at}`)
          UI.println(`    Status: ${r.status}`)
          UI.println(`    Preview: ${r.output.slice(0, 100)}${r.output.length > 100 ? "..." : ""}`)
          UI.println("")
        }
        return
      }

      UI.error(`Unknown action: ${action}. Use: create, list, remove, pause, resume, run, output, history`)
    })
  },
})
