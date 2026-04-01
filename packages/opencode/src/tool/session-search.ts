import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./session-search.txt"
import { Session } from "../session"
import { SessionID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { SessionStore } from "../memory/session-store"

export const SessionSearchTool = Tool.define("session_search", {
  description: DESCRIPTION,
  parameters: z.object({
    query: z.string().optional().describe("Search query. Omit to list recent sessions."),
    role_filter: z.string().optional().describe("Comma-separated roles to filter (e.g. 'user,assistant'). Defaults to all roles."),
    limit: z.number().optional().default(3).describe("Maximum number of sessions to return. Max 5."),
  }),
  async execute(params, ctx) {
    const limit = Math.min(params.limit ?? 3, 5)
    const currentSessionID = ctx.sessionID
    const roleFilters = params.role_filter?.split(",").map((r) => r.trim().toLowerCase())

    if (!params.query || params.query.trim() === "") {
      const recent = await SessionStore.getRecentSessions({ limit, excludeSessionID: currentSessionID })
      const enriched = await Promise.all(
        recent.map(async (r) => {
          const msgs = await Session.messages({ sessionID: SessionID.make(r.id), limit: 2 })
          return { ...r, preview: extractPreview(msgs) }
        }),
      )
      return {
        title: "recent sessions",
        output: JSON.stringify({ mode: "recent", sessions: enriched }, null, 2),
        metadata: { count: enriched.length },
      }
    }

    const results = await SessionStore.searchMessages(params.query, {
      sessionID: currentSessionID,
      roleFilter: roleFilters,
      limit,
    })

    if (results.length === 0) {
      return {
        title: "no results",
        output: JSON.stringify({ mode: "search", query: params.query, sessions: [] }, null, 2),
        metadata: { count: 0 },
      }
    }

    return {
      title: `search: ${params.query}`,
      output: JSON.stringify({ mode: "search", query: params.query, sessions: results }, null, 2),
      metadata: { count: results.length },
    }
  },
})

function extractPreview(messages: MessageV2.WithParts[]): string {
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "text" && part.text) {
        return part.text.slice(0, 200)
      }
    }
  }
  return ""
}
