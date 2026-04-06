import z from "zod"
import { Tool } from "./tool"
import { NanoBrowserBridge } from "./browser/bridge"

export const BrowserTool = Tool.define("browser", {
  description: `Control browser for web automation via NanoBrowser. Send a natural language task and the browser will autonomously navigate, click, type, and extract information.

Examples:
- "Find the cheapest wireless mouse on Amazon"
- "Go to github.com and check if opencode repo has any open issues"
- "Search for 'TypeScript 5.8 release notes' and summarize the first result"

Note: If this is the first time using the browser tool, you may need to run 'handofaicli browser setup' first to load the NanoBrowser extension in Chrome.`,
  parameters: z.object({
    task: z.string().describe("Natural language description of what you want the browser to do"),
  }),
  async execute(params, ctx) {
    const bridge = NanoBrowserBridge.getInstance()

    // Ensure bridge is initialized (will become owner or connect to existing owner)
    if (!bridge.getMode || bridge.getMode() === "uninitialized") {
      try {
        await bridge.start()
      } catch {
        return {
          title: "Browser not available",
          output: "Failed to initialize browser bridge. Please run 'handofaicli browser setup' first.",
          metadata: { silent: true },
        }
      }
    }

    // Collect progress updates
    const progressLines: string[] = []
    const progressHandler = (event: { actor: string; state: string; details: string; step: number; maxSteps: number }) => {
      const line = `[${event.actor}] ${event.state}: ${event.details} (step ${event.step}/${event.maxSteps})`
      progressLines.push(line)

      // Update metadata in real-time so agent can see progress
      // This follows the bash tool pattern
      ctx.metadata({
        title: `Browser: ${event.actor} - ${event.details} (${event.step}/${event.maxSteps})`,
        metadata: {
          progress: progressLines.join("\n"),
          currentStep: event.step,
          totalSteps: event.maxSteps,
          actor: event.actor,
          state: event.state,
          details: event.details,
        },
      })
    }

    try {
      const result = await bridge.executeTask(params.task, progressHandler)

      const output = result.success 
        ? `${progressLines.join("\n")}\n\n${result.result}`
        : `${progressLines.join("\n")}\n\nError: ${result.error}`

      return {
        title: result.success ? "Browser task complete" : "Browser task failed",
        output,
        metadata: { silent: true },
      }
    } catch (err) {
      return {
        title: "Browser task failed",
        output: `${progressLines.join("\n")}\n\nError: ${err instanceof Error ? err.message : String(err)}`,
        metadata: { silent: true },
      }
    }
  },
})
