import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { ToolRegistry } from "./registry"

export const DiscoverTool = Tool.define("discover", {
  description: `Discover and activate tools in your session.

Most tools are not visible by default and must be activated first.
Use discover.list() to see all tools that need discovery.
Use discover.help("toolname") to learn about a tool and mark it as activated.
Once activated, the tool stays available for the entire session.

TO CREATE CUSTOM TOOLS: Write TypeScript files to ~/.config/handofai/tool/{name}.ts
MUST use Zod schemas for args: import { z } from "zod"; args: { param: z.string().describe("...") }
IMPORTANT: Typecheck the file immediately after writing. Do NOT use local imports.
Tools are automatically loaded on restart and can be discovered.`,
  parameters: z.object({
    action: z.enum(["list", "help"]).describe("Action to perform"),
    tool: z.string().optional().describe("Tool name to get help for and discover"),
  }),
  async execute(params, ctx) {
    if (params.action === "list") {
      const sessionTools = Session.getSessionTools(ctx.sessionID)
      const discoveredTools = sessionTools.getAllTools()
      const undiscoveredBuiltin = sessionTools.getUndiscoveredBuiltinTools()
      const undiscoveredCustom = sessionTools.getUndiscoveredCustomTools()
      const alwaysAvailable: string[] = ["discover"]

      let output = ""

      // Always-available section
      output += "Always available (no discovery needed):\n"
      for (const name of alwaysAvailable) {
        output += `  - ${name}\n`
      }
      output += "\n"

      // Discovered section
      if (discoveredTools.length > 0) {
        output += "Activated (callable for this session):\n"
        for (const tool of discoveredTools) {
          output += `  - ${tool.name} (${tool.source})\n`
        }
        output += "\n"
      }

      // Undiscovered built-in section
      if (undiscoveredBuiltin.length > 0) {
        output += "Built-in tools (call discover.help to activate):\n"
        for (const name of undiscoveredBuiltin) {
          output += `  - ${name}\n`
        }
        output += "\n"
      }

      // Undiscovered custom section
      if (undiscoveredCustom.length > 0) {
        output += "Custom tools (call discover.help to activate):\n"
        for (const name of undiscoveredCustom) {
          output += `  - ${name}\n`
        }
        output += "\n"
      }

      if (undiscoveredBuiltin.length === 0 && undiscoveredCustom.length === 0 && discoveredTools.length === 0) {
        output += "All tools are already activated.\n"
      }

      output +=
        "Tip: Call discover.help('toolname') to learn about a tool and activate it.\n" +
        "Once activated, the tool will appear in your available tools for this session."

      return { output, title: "Tool Discovery", metadata: {} }
    }

    if (params.action === "help") {
      if (!params.tool) {
        return { output: "Error: tool name required for help action", title: "Discover help failed", metadata: {} }
      }

      const sessionTools = Session.getSessionTools(ctx.sessionID)
      const alwaysAvailable: string[] = ["discover"]

      // Get the tool definition from registry to show description
      const toolInfo = await ToolRegistry.tools({ providerID: {} as any, modelID: {} as any })
      const tool = toolInfo.find((t) => t.id === params.tool)

      // Check if already discovered
      if (sessionTools.hasTool(params.tool)) {
        const desc = tool?.description ?? ""
        return {
          output: `## ${params.tool} (ACTIVATED)\n\n${desc}\n\nThis tool is activated and available to call.`,
          title: `Discover: ${params.tool}`,
          metadata: {},
        }
      }

      // Always-available tools
      if (alwaysAvailable.includes(params.tool)) {
        const desc = tool?.description ?? ""
        return {
          output: `## ${params.tool} (ALWAYS AVAILABLE)\n\n${desc}\n\nThis tool is always available — no activation needed.`,
          title: `Built-in tool: ${params.tool}`,
          metadata: {},
        }
      }

      // Check if tool needs discovery (built-in or custom)
      const undiscoveredBuiltin = sessionTools.getUndiscoveredBuiltinTools()
      const undiscoveredCustom = sessionTools.getUndiscoveredCustomTools()

      if (undiscoveredBuiltin.includes(params.tool) || undiscoveredCustom.includes(params.tool)) {
        // Mark as discovered
        const source = undiscoveredBuiltin.includes(params.tool) ? "builtin" as const : "plugin" as const
        sessionTools.addTool({
          name: params.tool,
          source,
          metadata: {},
        })

        const desc = tool?.description ?? (source === "builtin" ? "Built-in tool" : "Custom tool from plugin or skill")
        return {
          output: `## ${params.tool} (NEWLY ACTIVATED)\n\n${desc}\n\nThis tool is now available to call. Use it in your next response.`,
          title: `Discovered: ${params.tool}`,
          metadata: { tool: params.tool } as Record<string, unknown>,
        }
      }

      return {
        output: `Tool '${params.tool}' not found. Call discover.list() to see all available tools.`,
        title: `Unknown tool: ${params.tool}`,
        metadata: {},
      }
    }

    return { output: "Invalid action", title: "Discover failed", metadata: {} }
  },
})
