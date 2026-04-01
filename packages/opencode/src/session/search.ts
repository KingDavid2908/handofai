import { Database, sql } from "@/storage/db"
import { MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { Log } from "@/util/log"

export namespace SessionSearch {
  const log = Log.create({ service: "session-search" })

  export const Result = {
    sessionID: "",
    sessionTitle: "",
    projectID: "",
    directory: "",
    timeCreated: 0,
    rank: 0,
    preview: "",
    matchCount: 0,
  }
  export type Result = typeof Result

  export async function search(query: string, opts?: {
    sessionID?: SessionID
    limit?: number
    roleFilter?: string[]
  }): Promise<Result[]> {
    if (!query.trim()) return []

    const limit = opts?.limit ?? 10
    const sessionFilter = opts?.sessionID
      ? sql`AND p.session_id = ${opts.sessionID}`
      : sql``

    let results: Array<{
      session_id: string
      session_title: string
      project_id: string
      directory: string
      time_created: number
      rank: number
      content: string
    }>
    try {
      results = await Database.Client().all(sql`
        SELECT
          s.id as session_id,
          s.title as session_title,
          s.project_id,
          s.directory,
          s.time_created,
          ps.rank,
          ps.content
        FROM part_search ps
        JOIN part p ON p.id = ps.rowid
        JOIN session s ON s.id = p.session_id
        WHERE part_search MATCH ${query}
          ${sessionFilter}
        ORDER BY ps.rank
        LIMIT ${limit}
      `)
    } catch {
      return []
    }

    return results.map((r) => ({
      sessionID: r.session_id,
      sessionTitle: r.session_title,
      projectID: r.project_id,
      directory: r.directory,
      timeCreated: r.time_created,
      rank: r.rank,
      preview: r.content.slice(0, 500),
      matchCount: 1,
    }))
  }

  export async function recent(opts?: { limit?: number }): Promise<{
    id: string
    title: string
    projectID: string
    directory: string
    timeCreated: number
    messageCount: number
  }[]> {
    const limit = opts?.limit ?? 10

    let results: Array<{
      id: string
      title: string
      project_id: string
      directory: string
      time_created: number
      message_count: number
    }>
    try {
      results = await Database.Client().all(sql`
        SELECT
          s.id,
          s.title,
          s.project_id,
          s.directory,
          s.time_created,
          COUNT(DISTINCT m.id) as message_count
        FROM session s
        LEFT JOIN message m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.time_created DESC
        LIMIT ${limit}
      `)
    } catch {
      return []
    }

    return results.map((r) => ({
      id: r.id,
      title: r.title,
      projectID: r.project_id,
      directory: r.directory,
      timeCreated: r.time_created,
      messageCount: r.message_count,
    }))
  }

  export async function rebuild(): Promise<void> {
    log.info("rebuilding FTS5 index")

    try {
      await Database.Client().run(sql`DELETE FROM part_search`)
    } catch {
      log.warn("FTS5 table not available, skipping rebuild")
      return
    }

    const parts = await Database.Client().all<{
      id: string
      session_id: string
      message_id: string
      data: string
    }>(sql`
      SELECT id, session_id, message_id, data FROM part
    `)

    for (const p of parts) {
      const content = extractContent(p.data)
      if (content.trim()) {
        try {
          await Database.Client().run(sql`
            INSERT INTO part_search(rowid, content, session_id, message_id)
            VALUES(${p.id}, ${content}, ${p.session_id}, ${p.message_id})
          `)
        } catch {
          // Skip individual parts that fail
        }
      }
    }

    log.info("FTS5 index rebuilt", { count: parts.length })
  }

  function extractContent(data: string): string {
    try {
      const parsed = JSON.parse(data)
      const parts: string[] = []

      if (parsed.text) parts.push(parsed.text)
      if (parsed.state?.input) parts.push(parsed.state.input)
      if (parsed.state?.output) parts.push(parsed.state.output)

      return parts.join(" ")
    } catch {
      return ""
    }
  }
}
