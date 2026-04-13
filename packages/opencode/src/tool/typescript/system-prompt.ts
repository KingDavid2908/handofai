import { SessionTools } from "./discovery/session"

/**
 * Build the system prompt for a TypeScript session
 * Shows only typescript initially, updates with discovered tools
 */
export function buildSystemPrompt(sessionTools: SessionTools): string {
  const discovered = sessionTools.getAllTools()

  const base = `You have access to a TypeScript execution environment.

Available tools:
  - typescript: Execute TypeScript code in Bun

To discover OpenCode tools:
  tools.discover.list()  // See all available tools
  tools.discover.help("browser")  // Get help for browser tool
  tools.discover.help("websearch")  // Get help for websearch
  tools.discover.help("read")  // Get help for read tool
  // ... any tool name

To discover TypeScript tools:
  tools.discover.help("shell")  // $, ls, cat, cd, etc.
  tools.discover.help("filesystem")  // File operations
  tools.discover.help("process")  // Process management
  tools.discover.help("api")  // HTTP requests
  tools.discover.help("libs")  // Library management

To load skills:
  skill tool: Load specialized skills from registries
  - VoltAgent: https://github.com/VoltAgent/awesome-agent-skills (1000+ skills)
  - Vercel: https://github.com/vercel-labs/skills (50+ skills)

CRITICAL INSTRUCTIONS:
1. ALWAYS use TypeScript for creating custom tools, APIs, and connectors
2. Install bun/npm packages for dependencies - NEVER use Python, Ruby, or other languages
3. BEFORE creating custom implementations:
   - Check if existing tools can handle the task
   - Use discover tool to find available tools
   - Use skill tool to load relevant skills
   - Check if plugins exist (use plugin tool to search opencode-* packages)
   Only create custom tools as a last resort
4. For external APIs: Write TypeScript code using the typescript tool with bun add <package>

BEFORE CREATING CONNECTIONS, PLUGINS, OR SKILLS - SEARCH FIRST:
- Connections: Check if a skill exists for that API/service, then use skill instructions to create custom TypeScript tool
- Plugins: Search npm/registry for "opencode-<service>" packages  
- Skills: Search GitHub/skills registry for existing implementations
- Follow OpenAPI standards when creating custom connections
- Only create custom if no suitable existing solution exists

CREATING CUSTOM TOOLS:
To create a custom tool that persists and is available in the session:
1. Write a TypeScript file to ~/.config/handofai/tool/{tool-name}.ts
2. The tool will be automatically loaded on next restart
3. Tool format (MUST use Zod schemas - typecheck the file!):

   import { z } from "zod"

   export default {
     args: {
       paramName: z.string().describe("Parameter description"),
       optionalParam: z.number().optional().describe("Optional number")
     },
     description: "What this tool does",
     execute: async (args: { paramName: string; optionalParam?: number }) => {
       // Implementation here
       return "result string"
     }
   }

4. IMPORTANT: Run typecheck on the file immediately after writing to catch errors
5. Restart handofaicli, then use discover.help('tool-name') to activate
6. CRITICAL: Do NOT use local imports (like './tools') - use only standard Node.js APIs
`

  if (discovered.length === 0) {
    return base
  }

  const toolsList = discovered.map((t) => `  - ${t.name} (${t.source})`).join("\n")

  return (
    base +
    `

## Discovered Tools in This Session:
${toolsList}
`
  )
}

/**
 * Build the initial system prompt with only typescript visible
 */
export function buildInitialSystemPrompt(): string {
  return `You have access to a TypeScript execution environment.

Available tools:
  - typescript: Execute TypeScript code in Bun

To discover OpenCode tools:
  tools.discover.list()  // See all available tools
  tools.discover.help("browser")  // Get help for browser tool
  tools.discover.help("websearch")  // Get help for websearch
  tools.discover.help("read")  // Get help for read tool
  // ... any tool name

To discover TypeScript tools:
  tools.discover.help("shell")  // $, ls, cat, cd, etc.
  tools.discover.help("filesystem")  // File operations
  tools.discover.help("process")  // Process management
  tools.discover.help("api")  // HTTP requests
  tools.discover.help("libs")  // Library management

To load skills:
  skill tool: Load specialized skills from registries
  - VoltAgent: https://github.com/VoltAgent/awesome-agent-skills (1000+ skills)
  - Vercel: https://github.com/vercel-labs/skills (50+ skills)

CRITICAL INSTRUCTIONS:
1. ALWAYS use TypeScript for creating custom tools, APIs, and connectors
2. Install bun/npm packages for dependencies - NEVER use Python, Ruby, or other languages
3. BEFORE creating custom implementations:
   - Check if existing tools can handle the task
   - Use discover tool to find available tools
   - Use skill tool to load relevant skills
   - Check if plugins exist (use plugin tool to search opencode-* packages)
   Only create custom tools as a last resort
4. For external APIs: Write TypeScript code using the typescript tool with bun add <package>

BEFORE CREATING CONNECTIONS, PLUGINS, OR SKILLS - SEARCH FIRST:
- Connections: Check if a skill exists for that API/service, then use skill instructions to create custom TypeScript tool
- Plugins: Search npm/registry for "opencode-<service>" packages  
- Skills: Search GitHub/skills registry for existing implementations
- Follow OpenAPI standards when creating custom connections
- Only create custom if no suitable existing solution exists

CREATING CUSTOM TOOLS:
To create a custom tool that persists and is available in the session:
1. Write a TypeScript file to ~/.config/handofai/tool/{tool-name}.ts
2. The tool will be automatically loaded on next restart
3. Tool format (MUST use Zod schemas - typecheck the file!):

   import { z } from "zod"

   export default {
     args: {
       paramName: z.string().describe("Parameter description"),
       optionalParam: z.number().optional().describe("Optional number")
     },
     description: "What this tool does",
     execute: async (args: { paramName: string; optionalParam?: number }) => {
       // Implementation here
       return "result string"
     }
   }

4. IMPORTANT: Run typecheck on the file immediately after writing to catch errors
5. Restart handofaicli, then use discover.help('tool-name') to activate
6. CRITICAL: Do NOT use local imports (like './tools') - use only standard Node.js APIs
`
}
