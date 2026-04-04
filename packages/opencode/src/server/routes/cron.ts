import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { CronJobs } from "@/scheduler/jobs"

export const CronRoutes = () =>
  new Hono()
    .get(
      "/jobs",
      describeRoute({
        summary: "List cron jobs",
        description: "List all cron jobs, optionally including disabled ones.",
        operationId: "cron.list",
        responses: {
          200: {
            description: "List of cron jobs",
            content: {
              "application/json": {
                schema: resolver(z.array(z.any())),
              },
            },
          },
        },
      }),
      async (c) => {
        const includeDisabled = c.req.query("include_disabled") === "true"
        const jobs = await CronJobs.list(includeDisabled)
        return c.json(jobs)
      },
    )
    .get(
      "/jobs/:id",
      describeRoute({
        summary: "Get cron job",
        description: "Get a single cron job by ID.",
        operationId: "cron.get",
        responses: {
          200: {
            description: "Cron job details",
            content: {
              "application/json": {
                schema: resolver(z.any()),
              },
            },
          },
          404: {
            description: "Job not found",
          },
        },
      }),
      async (c) => {
        const job = await CronJobs.get(c.req.param("id"))
        if (!job) return c.json({ error: "Job not found" }, 404)
        return c.json(job)
      },
    )
    .get(
      "/jobs/:id/output",
      describeRoute({
        summary: "Get cron job output",
        description: "Get the latest run output for a cron job, or a specific run by run_id query param.",
        operationId: "cron.output",
        responses: {
          200: {
            description: "Run output",
            content: {
              "application/json": {
                schema: resolver(z.any()),
              },
            },
          },
          404: {
            description: "Job or run not found",
          },
        },
      }),
      async (c) => {
        const runId = c.req.query("run_id")
        const result = await CronJobs.getOutput(c.req.param("id"), runId)
        if (!result) return c.json({ error: "Job not found" }, 404)
        if (!result.latest) return c.json({ error: "No output found" }, 404)
        return c.json({
          job_id: result.job.id,
          run_id: result.latest.id,
          session_id: result.latest.session_id,
          started_at: result.latest.started_at,
          finished_at: result.latest.finished_at,
          status: result.latest.status,
          error: result.latest.error,
          output: result.latest.output,
        })
      },
    )
    .get(
      "/jobs/:id/history",
      describeRoute({
        summary: "Get cron job run history",
        description: "Get all run history for a cron job.",
        operationId: "cron.history",
        responses: {
          200: {
            description: "Run history",
            content: {
              "application/json": {
                schema: resolver(z.array(z.any())),
              },
            },
          },
          404: {
            description: "Job not found",
          },
        },
      }),
      async (c) => {
        const result = await CronJobs.getOutput(c.req.param("id"))
        if (!result) return c.json({ error: "Job not found" }, 404)
        return c.json(result.records.map((r, i) => ({
          run: i + 1,
          id: r.id,
          session_id: r.session_id,
          started_at: r.started_at,
          finished_at: r.finished_at,
          status: r.status,
          error: r.error,
          preview: r.output.slice(0, 200) + (r.output.length > 200 ? "..." : ""),
        })))
      },
    )
