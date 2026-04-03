import z from "zod"
import { Tool } from "./tool"
import { getProcessRegistry } from "./bash/process-registry"

export const ProcessTool = Tool.define("process", async () => {
  return {
    description: `Manage background processes started with bash(background=true).

Actions:
- list: Show all running and finished processes
- poll: Check status and recent output of a process
- log: Get full output with optional pagination
- wait: Block until process exits or timeout
- kill: Terminate a running process
- write: Send raw text to process stdin (no newline)
- submit: Send text + newline to stdin (like pressing Enter)

Use list to find process IDs, then use poll/log/wait/kill for management.`,
    parameters: z.object({
      action: z.enum(["list", "poll", "log", "wait", "kill", "write", "submit"])
        .describe("Action to perform"),
      process_id: z.string().optional()
        .describe("Process session ID from bash background output"),
      input: z.string().optional()
        .describe("Text to send to stdin (write/submit only)"),
      timeout: z.number().optional()
        .describe("Max seconds to wait"),
      offset: z.number().optional()
        .describe("Line offset for log pagination"),
      limit: z.number().optional()
        .describe("Max lines for log"),
    }),
    async execute(params) {
      const registry = getProcessRegistry()

      switch (params.action) {
        case "list": {
          const sessions = registry.list("")
          if (sessions.length === 0) {
            return { output: "No background processes.", title: "Process list", metadata: {} }
          }
          const lines = [
            `Background processes (${sessions.length}):`,
            "",
            ...sessions.map((s) => {
              const status = s.running ? "running" : `exited(${s.exitCode})`
              const uptime = Math.floor((Date.now() - s.startedAt.getTime()) / 1000)
              const preview = s.output.slice(-100).replace(/\n/g, " ")
              return `[${s.id}] ${status} (${uptime}s) — ${s.command.slice(0, 50)}${s.command.length > 50 ? "..." : ""}`
            }),
          ]
          return { output: lines.join("\n"), title: `Process list (${sessions.length})`, metadata: {} }
        }

        case "poll": {
          if (!params.process_id) {
            return { output: "Error: process_id is required for poll.", title: "Process poll failed", metadata: {} }
          }
          const result = registry.poll(params.process_id)
          if (!result.running && result.exitCode === -1) {
            return { output: `Process '${params.process_id}' not found.`, title: "Process poll", metadata: {} }
          }
          const status = result.running ? "running" : `exited(${result.exitCode})`
          const lines = [`Process: ${params.process_id}`, `Status: ${status}`, `Output:`, result.output.slice(-2000) || "(no output yet)"]
          return { output: lines.join("\n"), title: `Process poll: ${status}`, metadata: {} }
        }

        case "log": {
          if (!params.process_id) {
            return { output: "Error: process_id is required for log.", title: "Process log failed", metadata: {} }
          }
          const tail = params.limit || 200
          const output = registry.log(params.process_id, tail)
          if (!output && output !== "") {
            return { output: `Process '${params.process_id}' not found.`, title: "Process log", metadata: {} }
          }
          const lines = output.split("\n")
          const total = lines.length
          const shown = params.offset ? lines.slice(params.offset).slice(-tail) : lines.slice(-tail)
          return { output: shown.join("\n"), title: `Process log: ${total} lines`, metadata: { total, showing: shown.length } }
        }

        case "wait": {
          if (!params.process_id) {
            return { output: "Error: process_id is required for wait.", title: "Process wait failed", metadata: {} }
          }
          const timeoutMs = (params.timeout ?? 60) * 1000
          const session = await registry.wait(params.process_id, timeoutMs)
          const timedOut = session.running
          const status = timedOut ? "timeout" : session.exitCode === 0 ? "exited(0)" : `exited(${session.exitCode})`
          const lines = [
            `Process '${params.process_id}' ${status}`,
            timedOut ? "(timeout - process still running, use kill to terminate)" : `Output:`,
            session.output.slice(-2000) || "(no output)",
          ]
          return { output: lines.join("\n"), title: `Process ${status}`, metadata: { timedOut } }
        }

        case "kill": {
          if (!params.process_id) {
            return { output: "Error: process_id is required for kill.", title: "Process kill failed", metadata: {} }
          }
          registry.kill(params.process_id)
          return { output: `Process '${params.process_id}' terminated.`, title: "Process killed", metadata: {} }
        }

        case "write": {
          if (!params.process_id) {
            return { output: "Error: process_id is required for write.", title: "Process write failed", metadata: {} }
          }
          if (params.input === undefined) {
            return { output: "Error: input is required for write.", title: "Process write failed", metadata: {} }
          }
          registry.write(params.process_id, params.input)
          return { output: `Sent ${params.input.length} bytes to '${params.process_id}'.`, title: "Process write", metadata: {} }
        }

        case "submit": {
          if (!params.process_id) {
            return { output: "Error: process_id is required for submit.", title: "Process submit failed", metadata: {} }
          }
          if (params.input === undefined) {
            return { output: "Error: input is required for submit.", title: "Process submit failed", metadata: {} }
          }
          registry.submit(params.process_id, params.input)
          return { output: `Submitted to '${params.process_id}': "${params.input}"`, title: "Process submit", metadata: {} }
        }
      }
    },
  }
})
