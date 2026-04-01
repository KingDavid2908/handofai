import { Database, sql } from "@/storage/db"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"

const DEFAULT_SESSION_LIMIT = 3
const MAX_SESSION_LIMIT = 5

export namespace SessionStore {
  export interface SearchResult {
    sessionID: string
    sessionTitle: string
    projectID: string
    directory: string
    timeCreated: number
    preview: string
  }

  export interface SessionMeta {
    id: string
    title: string
    projectID: string
    directory: string
    timeCreated: number
    messageCount: number
  }

  export async function searchMessages(query: string, opts?: {
    sessionID?: SessionID
    roleFilter?: string[]
    limit?: number
  }): Promise<SearchResult[]> {
    if (!query.trim()) return []

    const limit = Math.min(opts?.limit ?? DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT)
    const excludeSessionID = opts?.sessionID
    const roleFilters = opts?.roleFilter ?? []

    let results: Array<{
      session_id: string
      session_title: string
      project_id: string
      directory: string
      time_created: number
      content: string
    }>
    try {
      results = await Database.Client().all(sql`
        SELECT DISTINCT
          s.id as session_id,
          s.title as session_title,
          s.project_id,
          s.directory,
          s.time_created,
          ps.content
        FROM part_search ps
        JOIN session s ON s.id = ps.session_id
        WHERE part_search MATCH ${query}
        LIMIT 50
      `)
    } catch {
      return []
    }

    const seen = new Set<string>()
    const sessionGroups: SearchResult[] = []

    for (const r of results) {
      const parentID = await resolveToParent(r.session_id)
      if (excludeSessionID && parentID === excludeSessionID) continue
      if (excludeSessionID && await isDescendant(parentID, excludeSessionID)) continue
      if (seen.has(parentID)) continue

      seen.add(parentID)
      if (sessionGroups.length >= limit) break

      let preview = r.content.slice(0, 500)
      if (roleFilters.length > 0) {
        const msgs = await Session.messages({ sessionID: SessionID.make(parentID), limit: 20 })
        preview = filterByRole(msgs, roleFilters).slice(0, 500)
      }

      sessionGroups.push({
        sessionID: parentID,
        sessionTitle: r.session_title,
        projectID: r.project_id,
        directory: r.directory,
        timeCreated: r.time_created,
        preview: preview + (r.content.length > 500 ? "..." : ""),
      })
    }

    return sessionGroups
  }

  export async function getRecentSessions(opts?: { limit?: number; excludeSessionID?: SessionID }): Promise<SessionMeta[]> {
    const limit = opts?.limit ?? DEFAULT_SESSION_LIMIT
    const excludeSessionID = opts?.excludeSessionID

    const sessions = await Session.listGlobal()
    const recent: SessionMeta[] = []

    for (const s of sessions) {
      if (excludeSessionID && s.id === excludeSessionID) continue
      if (excludeSessionID && await isDescendant(s.id, excludeSessionID)) continue

      recent.push({
        id: s.id,
        title: s.title,
        projectID: s.projectID,
        directory: s.directory,
        timeCreated: s.time.created,
        messageCount: 0,
      })

      if (recent.length >= limit) break
    }

    return recent
  }

  export async function loadSession(sessionID: string, maxChars?: number): Promise<MessageV2.WithParts[]> {
    const msgs = await Session.messages({ sessionID: SessionID.make(sessionID) })
    let totalChars = 0
    const truncated: MessageV2.WithParts[] = []

    for (const msg of msgs) {
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          totalChars += part.text.length
        }
      }
      if (totalChars > (maxChars ?? 100000)) break
      truncated.push(msg)
    }

    return truncated
  }

  export async function rebuildIndex(): Promise<void> {
    try {
      await Database.Client().run(sql`DELETE FROM part_search`)
    } catch {
      return
    }

    const sessions = await Session.listGlobal()
    for (const s of sessions) {
      try {
        const msgs = await Session.messages({ sessionID: s.id })
        for (const msg of msgs) {
          for (const part of msg.parts) {
            if (part.type === "text" && part.text) {
              try {
                // Ensure all values are explicitly strings to avoid datatype mismatch
                const content = String(part.text)
                const sessionId = String(s.id)
                const messageId = String(msg.info.id)
                await Database.Client().run(sql`
                  INSERT INTO part_search(content, session_id, message_id)
                  VALUES(${content}, ${sessionId}, ${messageId})
                `)
              } catch {
                // Skip parts that fail to insert
              }
            }
          }
        }
      } catch {
        // Skip sessions that fail to load
      }
    }
  }

  async function resolveToParent(sessionID: string): Promise<string> {
    try {
      const session = await Session.get(SessionID.make(sessionID))
      if (session.parentID) {
        return resolveToParent(session.parentID)
      }
      return sessionID
    } catch {
      return sessionID
    }
  }

  async function isDescendant(sessionID: string, ancestorID: string): Promise<boolean> {
    try {
      const session = await Session.get(SessionID.make(sessionID))
      if (!session) return false
      if (session.parentID === ancestorID) return true
      if (session.parentID) return isDescendant(session.parentID, ancestorID)
      return false
    } catch {
      return false
    }
  }

  function filterByRole(messages: MessageV2.WithParts[], roles: string[]): string {
    const parts: string[] = []
    for (const msg of messages) {
      const role = msg.info.role
      if (roles.length > 0 && !roles.includes(role)) continue
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          parts.push(`${role}: ${part.text}`)
        }
      }
    }
    return parts.join("\n\n")
  }
}
