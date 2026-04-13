import { SyncEvent } from "@/sync"
import { Log } from "@/util/log"

const log = Log.create({ service: "session-tools" })

export type ToolSource = "skill" | "connector" | "plugin" | "builtin"

export interface DiscoveredTool {
  name: string
  source: ToolSource
  metadata?: Record<string, unknown>
}

export class SessionTools {
  private tools: Map<string, DiscoveredTool> = new Map()
  private sessionId: string
  private availableCustomTools: Set<string> = new Set()

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  /**
   * Register a custom tool that exists but needs discovery
   * These tools will show in discover.list() but aren't callable until discovered
   */
  registerCustomTool(toolName: string, source: ToolSource = "plugin"): void {
    this.availableCustomTools.add(toolName)
    log.debug("Custom tool registered (needs discovery)", {
      sessionId: this.sessionId,
      name: toolName,
      source,
    })
  }

  /**
   * Get list of custom tools that need discovery
   */
  getUndiscoveredCustomTools(): string[] {
    return Array.from(this.availableCustomTools).filter((name) => !this.tools.has(name))
  }

  /**
   * Get list of all available custom tool names (both discovered and undiscovered)
   */
  getAvailableCustomTools(): string[] {
    return Array.from(this.availableCustomTools)
  }

  /**
   * Check if a custom tool has been discovered
   */
  isCustomToolDiscovered(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * Load previously discovered tools from the event log
   * This replays all tool-related events to reconstruct the session state
   */
  loadFromEvents(): void {
    log.info("Loading tools from event log", { sessionId: this.sessionId })

    // Subscribe to all events and filter for tool events
    const unsubscribe = SyncEvent.subscribeAll((event) => {
      const { def, event: evt } = event

      switch (def.type) {
        case SyncEvent.ToolEvent.SkillInstalled.type:
          this.addTool({
            name: (evt.data as { name: string }).name,
            source: "skill",
            metadata: {
              location: (evt.data as { location: string }).location,
              source: (evt.data as { source?: string }).source,
            },
          })
          break

        case SyncEvent.ToolEvent.SkillRemoved.type:
          this.removeTool((evt.data as { name: string }).name)
          break

        case SyncEvent.ToolEvent.ConnectorAdded.type:
          this.addTool({
            name: (evt.data as { name: string }).name,
            source: "connector",
            metadata: {
              baseUrl: (evt.data as { baseUrl: string }).baseUrl,
            },
          })
          break

        case SyncEvent.ToolEvent.ConnectorRemoved.type:
          this.removeTool((evt.data as { name: string }).name)
          break

        case SyncEvent.ToolEvent.PluginInstalled.type:
          this.addTool({
            name: (evt.data as { name: string }).name,
            source: "plugin",
            metadata: {
              source: (evt.data as { source: "npm" | "local" }).source,
            },
          })
          break

        case SyncEvent.ToolEvent.PluginRemoved.type:
          this.removeTool((evt.data as { name: string }).name)
          break
      }
    })

    // Unsubscribe immediately since we only want to replay existing events
    unsubscribe()

    log.info("Finished loading tools from event log", {
      sessionId: this.sessionId,
      toolCount: this.tools.size,
    })
  }

  /**
   * Add a discovered tool to the session
   */
  addTool(tool: DiscoveredTool): void {
    this.tools.set(tool.name, tool)
    log.debug("Tool added to session", {
      sessionId: this.sessionId,
      name: tool.name,
      source: tool.source,
    })
  }

  /**
   * Remove a tool from the session
   */
  removeTool(name: string): void {
    this.tools.delete(name)
    log.debug("Tool removed from session", {
      sessionId: this.sessionId,
      name,
    })
  }

  /**
   * Check if a tool has been discovered in this session
   */
  hasTool(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * Get a specific tool by name
   */
  getTool(name: string): DiscoveredTool | undefined {
    return this.tools.get(name)
  }

  /**
   * Get all discovered tools
   */
  getAllTools(): DiscoveredTool[] {
    return Array.from(this.tools.values())
  }

  /**
   * Get tools filtered by source
   */
  getToolsBySource(source: ToolSource): DiscoveredTool[] {
    return this.getAllTools().filter((tool) => tool.source === source)
  }

  /**
   * Get the count of discovered tools
   */
  getToolCount(): number {
    return this.tools.size
  }

  /**
   * Clear all tools (useful for testing or session reset)
   */
  clear(): void {
    this.tools.clear()
    log.debug("Session tools cleared", { sessionId: this.sessionId })
  }
}

/**
 * Factory function to create a SessionTools instance
 */
export function createSessionTools(sessionId: string): SessionTools {
  return new SessionTools(sessionId)
}
