import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
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
