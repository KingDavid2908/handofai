import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

const TodoItemSchema = z.object({
  id: z.string().optional().describe("Unique item identifier. Auto-generated if not provided."),
  content: z.string().optional().describe("Brief description of the task"),
  status: z.string().optional().describe("Current status: pending, in_progress, completed, cancelled"),
  priority: z.string().optional().describe("Priority level: high, medium, low"),
})

export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(TodoItemSchema).describe("The updated todo list"),
    merge: z.boolean().optional().default(false).describe("true: update existing items by id, add new ones. false (default): replace entire list."),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
      merge: params.merge ?? false,
    })

    const current = Todo.get(ctx.sessionID)
    return {
      title: `${current.filter((x) => x.status !== "completed").length} todos`,
      output: JSON.stringify(current, null, 2),
      metadata: {
        todos: current,
      },
    }
  },
})
