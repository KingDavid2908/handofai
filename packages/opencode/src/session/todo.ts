import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import z from "zod"
import { Database, eq, asc } from "../storage/db"
import { TodoTable } from "./session.sql"

export namespace Todo {
  export const Info = z
    .object({
      id: z.string().optional().describe("Unique item identifier. Auto-generated if not provided."),
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
      priority: z.string().describe("Priority level of the task: high, medium, low"),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: SessionID.zod,
        todos: z.array(Info),
      }),
    ),
  }

  export function update(input: { sessionID: SessionID; todos: Info[]; merge?: boolean }) {
    if (input.merge) {
      const existing = get(input.sessionID)
      const byId = new Map(existing.map((t) => [t.id, t]))

      for (const todo of input.todos) {
        if (todo.id && byId.has(todo.id)) {
          const existingTodo = byId.get(todo.id)!
          byId.set(todo.id, {
            ...existingTodo,
            ...(todo.content !== undefined ? { content: todo.content } : {}),
            ...(todo.status !== undefined ? { status: todo.status } : {}),
            ...(todo.priority !== undefined ? { priority: todo.priority } : {}),
          })
        } else {
          const id = todo.id ?? crypto.randomUUID()
          byId.set(id, { ...todo, id })
        }
      }

      const merged = Array.from(byId.values())
      Database.transaction((db) => {
        db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
        if (merged.length === 0) return
        db.insert(TodoTable)
          .values(
            merged.map((todo, position) => ({
              session_id: input.sessionID,
              id: todo.id,
              content: todo.content,
              status: todo.status,
              priority: todo.priority,
              position,
            })),
          )
          .run()
      })
      Bus.publish(Event.Updated, { sessionID: input.sessionID, todos: merged })
    } else {
      const byId = new Map<string, Info>()
      for (const todo of input.todos) {
        const id = todo.id ?? crypto.randomUUID()
        byId.set(id, { ...todo, id })
      }

      const deduped = Array.from(byId.values())
      Database.transaction((db) => {
        db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
        if (deduped.length === 0) return
        db.insert(TodoTable)
          .values(
            deduped.map((todo, position) => ({
              session_id: input.sessionID,
              id: todo.id,
              content: todo.content,
              status: todo.status,
              priority: todo.priority,
              position,
            })),
          )
          .run()
      })
      Bus.publish(Event.Updated, { sessionID: input.sessionID, todos: deduped })
    }
  }

  export function get(sessionID: SessionID) {
    const rows = Database.use((db) =>
      db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
    )
    return rows.map((row) => ({
      id: row.id ?? "",
      content: row.content,
      status: row.status,
      priority: row.priority,
    }))
  }

  export function formatForInjection(todos: Info[]): string | null {
    const markers: Record<string, string> = {
      completed: "[x]",
      in_progress: "[>]",
      pending: "[ ]",
      cancelled: "[~]",
    }
    const active = todos.filter((t) => t.status === "pending" || t.status === "in_progress")
    if (active.length === 0) return null
    const lines = ["[Your active task list was preserved across context compression]"]
    for (const t of active) {
      const marker = markers[t.status] ?? "[?]"
      lines.push(`- ${marker} ${t.id}. ${t.content} (${t.status})`)
    }
    return lines.join("\n")
  }
}
