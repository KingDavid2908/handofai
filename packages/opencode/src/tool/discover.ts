import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { ToolRegistry } from "./registry"

export const DiscoverTool = Tool.define("discover", {
  description: `Discover custom tools to make them available in your session.

Some tools are not visible by default and must be discovered first.
This includes custom tools from plugins, skills, connectors, or TypeScript files in ~/.config/handofai/tool/.
Use discover.list() to see tools that need discovery.
Use discover.help("toolname") to learn about a tool and mark it as discovered.
Once discovered, the tool becomes available to call.

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
      const undiscovered = sessionTools.getUndiscoveredCustomTools()
      const discovered = sessionTools.getAllTools()

      let output = "Custom Tools Status:\n\n"

      if (discovered.length > 0) {
        output += "Discovered (callable):\n"
        for (const tool of discovered) {
          output += `  - ${tool.name} (${tool.source})\n`
        }
        output += "\n"
      }

      if (undiscovered.length > 0) {
        output += "Available (call discover.help to activate):\n"
        for (const toolName of undiscovered) {
          output += `  - ${toolName}\n`
        }
        output += "\n"
      }

      if (discovered.length === 0 && undiscovered.length === 0) {
        output += "No custom tools available.\n\nCustom tools can come from:\n"
        output += "  - Plugins (opencode-* npm packages)\n"
        output += "  - Skills (loaded via skill tool)\n"
        output += "  - TypeScript files in ~/.config/handofai/tool/*.ts\n\n"
        output += "To create a custom tool (MUST use Zod schemas):\n\n"
        output += "import { z } from 'zod'\n\n"
        output += "export default {\n"
        output += "  args: {\n"
        output += "    param: z.string().describe('Parameter description'),\n"
        output += "    optionalParam: z.number().optional()\n"
        output += "  },\n"
        output += "  description: 'What this tool does',\n"
        output += "  execute: async (args: { param: string; optionalParam?: number }) => {\n"
        output += "    return 'result'\n"
        output += "  }\n"
        output += "}\n\n"
        output += "IMPORTANT: Typecheck the file immediately. No local imports. Restart to load.\n"
      }

      output +=
        "Tip: Call discover.help('toolname') to learn about a tool and activate it.\n" +
        "Once activated, the tool will appear in your available tools."

      return { output, title: "Tool Discovery", metadata: {} }
    }

    if (params.action === "help") {
      if (!params.tool) {
        return { output: "Error: tool name required for help action", title: "Discover help failed", metadata: {} }
      }

      const sessionTools = Session.getSessionTools(ctx.sessionID)
      const undiscovered = sessionTools.getUndiscoveredCustomTools()
      const isDiscovered = sessionTools.hasTool(params.tool)

      // Get the tool definition from registry to show description
      const toolInfo = await ToolRegistry.tools({ providerID: {} as any, modelID: {} as any })
      const tool = toolInfo.find((t) => t.id === params.tool)

      if (isDiscovered) {
        // Tool already discovered - show full info
        if (tool) {
          return {
            output: `## ${params.tool} (DISCOVERED)\n\n${tool.description}\n\nThis tool is now available to call.`,
            title: `Discover: ${params.tool}`,
            metadata: {},
          }
        }
        return {
          output: `## ${params.tool} (DISCOVERED)\n\nThis tool is now available to call.`,
          title: `Discover: ${params.tool}`,
          metadata: {},
        }
      }

      if (undiscovered.includes(params.tool)) {
        // Mark as discovered
        sessionTools.addTool({
          name: params.tool,
          source: "plugin",
          metadata: {},
        })

        const desc = tool?.description ?? "Custom tool from plugin or skill"
        return {
          output: `## ${params.tool} (NEWLY DISCOVERED)\n\n${desc}\n\nThis tool is now available to call. Use it in your next response.`,
          title: `Discovered: ${params.tool}`,
          metadata: { tool: params.tool } as Record<string, unknown>,
        }
      }

      // Check if it's a built-in tool
      const builtinTools = [
        "bash", "browser", "websearch", "webfetch", "read", "write", "edit", "grep", "glob", "task",
        "memory", "vision", "skill", "todo", "codesearch", "session_search", "lesson", "skills_list",
        "skill_manage", "moa", "cronjob", "apply_patch", "question", "process", "shell", "filesystem",
      ]

      if (builtinTools.includes(params.tool)) {
        return {
          output: `${params.tool} is a built-in OpenCode tool that is always available. You don't need to discover it.`,
          title: `Built-in tool: ${params.tool}`,
          metadata: {},
        }
      }

      return {
        output: `Tool '${params.tool}' not found. It may not be registered as a custom tool.`,
        title: `Unknown tool: ${params.tool}`,
        metadata: {},
      }
    }

    return { output: "Invalid action", title: "Discover failed", metadata: {} }
  },
})
