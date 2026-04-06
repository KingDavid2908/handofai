import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { SessionID, MessageID, PartID } from "./schema"
import { Todo } from "./todo"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/db"
import { ModelID, ProviderID } from "@/provider/schema"
import { Cause, Effect, Exit, Layer, ServiceMap } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { isOverflow as overflow } from "./overflow"
import { MemoryStore } from "@/memory/memory-store"
import { MemoryTool } from "@/tool/memory"
import { SkillManageTool } from "@/tool/skill-manage"
import { ToolRegistry } from "@/tool/registry"
import { LLM } from "./llm"
import { Permission } from "@/permission"
import { streamText, type ModelMessage, tool, jsonSchema } from "ai"
import { ProviderTransform } from "@/provider/transform"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000
  const PRUNE_PROTECTED_TOOLS = ["skill", "skill_manage"]

  export interface Interface {
    readonly isOverflow: (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) => Effect.Effect<boolean>
    readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
    readonly process: (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      abort: AbortSignal
      auto: boolean
      overflow?: boolean
    }) => Effect.Effect<"continue" | "stop">
    readonly create: (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionCompaction") {}

  export const layer: Layer.Layer<
    Service,
    never,
    Bus.Service | Config.Service | Session.Service | Agent.Service | Plugin.Service | SessionProcessor.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const config = yield* Config.Service
      const session = yield* Session.Service
      const agents = yield* Agent.Service
      const plugin = yield* Plugin.Service
      const processors = yield* SessionProcessor.Service

      const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
        tokens: MessageV2.Assistant["tokens"]
        model: Provider.Model
      }) {
        return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
      })

      const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
        const cfg = yield* config.get()
        if (cfg.compaction?.prune === false) return
        log.info("pruning")

        const msgs = yield* session
          .messages({ sessionID: input.sessionID })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
        if (!msgs) return

        let total = 0
        let pruned = 0
        const toPrune: MessageV2.ToolPart[] = []
        let turns = 0

        loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
          const msg = msgs[msgIndex]
          if (msg.info.role === "user") turns++
          if (turns < 2) continue
          if (msg.info.role === "assistant" && msg.info.summary) break loop
          for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
            const part = msg.parts[partIndex]
            if (part.type === "tool")
              if (part.state.status === "completed") {
                if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
                if (part.state.time.compacted) break loop
                const estimate = Token.estimate(part.state.output)
                total += estimate
                if (total > PRUNE_PROTECT) {
                  pruned += estimate
                  toPrune.push(part)
                }
              }
          }
        }

        log.info("found", { pruned, total })
        if (pruned > PRUNE_MINIMUM) {
          for (const part of toPrune) {
            if (part.state.status === "completed") {
              part.state.time.compacted = Date.now()
              yield* session.updatePart(part)
            }
          }
          log.info("pruned", { count: toPrune.length })
        }
      })

      // Memory flush: LLM-powered save-before-compaction using ONLY the memory tool
      // Follows Hermes pattern: inject synthetic prompt, call LLM with only memory tool, execute tool calls, strip artifacts
      async function memoryFlush(input: {
        messages: MessageV2.WithParts[]
        sessionID: SessionID
        abort: AbortSignal
      }) {
        const sentinel = "__MEMORY_FLUSH_SENTINEL__"

        // Get the compaction agent
        const compactionAgent = await Agent.get("compaction").catch(() => Agent.get("default"))
        if (!compactionAgent) return

        // Get model from the last user message or compaction agent
        const lastUser = input.messages.findLast((m) => m.info.role === "user")
        const modelInfo = lastUser?.info && "model" in lastUser.info
          ? (lastUser.info as any).model
          : compactionAgent.model ?? { providerID: "opencode", modelID: "default" }

        const model = await Provider.getModel(modelInfo.providerID, modelInfo.modelID).catch(() => null)
        if (!model) return

        // Build memory tool as AI SDK tool
        const memoryToolInfo = await MemoryTool.init()
        const memoryAITool = tool({
          id: MemoryTool.id as any,
          description: memoryToolInfo.description,
          inputSchema: jsonSchema(z.toJSONSchema(memoryToolInfo.parameters) as any),
          async execute(args: any, options) {
            const result = await memoryToolInfo.execute(args, {
              sessionID: input.sessionID,
              messageID: MessageID.ascending(),
              agent: compactionAgent.name,
              abort: input.abort,
              callID: options.toolCallId,
              extra: { model, bypassAgentCheck: true },
              messages: input.messages,
              metadata: async () => {},
              ask: async () => {},
            })
            return {
              output: result.output,
              metadata: result.metadata,
            }
          },
        })

        // Build skill-manage tool as AI SDK tool
        const skillManageToolInfo = await SkillManageTool.init()
        const skillManageAITool = tool({
          id: SkillManageTool.id as any,
          description: skillManageToolInfo.description,
          inputSchema: jsonSchema(z.toJSONSchema(skillManageToolInfo.parameters) as any),
          async execute(args: any, options) {
            const result = await skillManageToolInfo.execute(args, {
              sessionID: input.sessionID,
              messageID: MessageID.ascending(),
              agent: compactionAgent.name,
              abort: input.abort,
              callID: options.toolCallId,
              extra: { model, bypassAgentCheck: true },
              messages: input.messages,
              metadata: async () => {},
              ask: async () => {},
            })
            return {
              output: result.output,
              metadata: result.metadata,
            }
          },
        })

        // Convert messages to model format
        const modelMessages = await MessageV2.toModelMessages(input.messages, model, { stripMedia: true })

        // Get the language model for the flush
        const languageModel = await Provider.getLanguage(model).catch(() => null)
        if (!languageModel) return

        // Stream with memory and skill-manage tools
        const flushPrompt = `[System: The session is being compacted. Save anything worth remembering to memory. Also consider creating or updating skills if a reusable approach was discovered. If nothing is worth saving, do not call any tools. ${sentinel}]`
        try {
          const result = streamText({
            model: languageModel,
            messages: [
              ...modelMessages,
              { role: "user", content: [{ type: "text", text: flushPrompt }] },
            ],
            tools: { memory: memoryAITool, skill_manage: skillManageAITool },
            abortSignal: input.abort,
          })

          // Consume the stream - tool calls are auto-executed by AI SDK
          for await (const part of result.fullStream) {
            // Just consume - memory tool calls execute automatically
          }

          log.info("memory flush completed")
        } catch (e) {
          log.error("memory flush failed", { error: e })
        }
      }

      const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
        parentID: MessageID
        messages: MessageV2.WithParts[]
        sessionID: SessionID
        abort: AbortSignal
        auto: boolean
        overflow?: boolean
      }) {
        // Memory flush before compaction (Hermes pattern: LLM-powered save-before-compact)
        if (MemoryStore.isInitialized()) {
          const userTurns = input.messages.filter((m) => m.info.role === "user").length
          const cfg = yield* config.get()
          const flushMinTurns = cfg.memory?.flush_min_turns ?? 6
          const effectiveMin = input.overflow ? 0 : flushMinTurns

          if (userTurns >= effectiveMin && input.messages.length >= 3) {
            log.info("flushing memories before compaction")
            try {
              yield* Effect.promise(() => memoryFlush({
                messages: input.messages,
                sessionID: input.sessionID,
                abort: input.abort,
              }))
            } catch (e) {
              log.error("memory flush failed", { error: e })
            }
          }
        }

        const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User

        let messages = input.messages
        let replay: MessageV2.WithParts | undefined
        if (input.overflow) {
          const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
          for (let i = idx - 1; i >= 0; i--) {
            const msg = input.messages[i]
            if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
              replay = msg
              messages = input.messages.slice(0, i)
              break
            }
          }
          const hasContent =
            replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
          if (!hasContent) {
            replay = undefined
            messages = input.messages
          }
        }

        const agent = yield* agents.get("compaction")
        const model = yield* Effect.promise(() =>
          agent.model
            ? Provider.getModel(agent.model.providerID, agent.model.modelID)
            : Provider.getModel(userMessage.model.providerID, userMessage.model.modelID),
        )
        // Allow plugins to inject context or replace compaction prompt.
        const compacting = yield* plugin.trigger(
          "experimental.session.compacting",
          { sessionID: input.sessionID },
          { context: [], prompt: undefined },
        )
        const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.
Do not call any tools. Respond only with the summary text.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`

        const prompt = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
        const msgs = structuredClone(messages)
        yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
        const modelMessages = yield* Effect.promise(() => MessageV2.toModelMessages(msgs, model, { stripMedia: true }))
        const msg = (yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: input.parentID,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          variant: userMessage.variant,
          summary: true,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        const processor = yield* processors.create({
          assistantMessage: msg,
          sessionID: input.sessionID,
          model,
          abort: input.abort,
        })
        const cancel = Effect.fn("SessionCompaction.cancel")(function* () {
          if (!input.abort.aborted || msg.time.completed) return
          msg.error = msg.error ?? new MessageV2.AbortedError({ message: "Aborted" }).toObject()
          msg.finish = msg.finish ?? "error"
          msg.time.completed = Date.now()
          yield* session.updateMessage(msg)
        })
        const result = yield* processor
          .process({
            user: userMessage,
            agent,
            abort: input.abort,
            sessionID: input.sessionID,
            tools: {},
            system: [],
            messages: [
              ...modelMessages,
              {
                role: "user",
                content: [{ type: "text", text: prompt }],
              },
            ],
            model,
          })
          .pipe(Effect.ensuring(cancel()))

        if (result === "compact") {
          processor.message.error = new MessageV2.ContextOverflowError({
            message: replay
              ? "Conversation history too large to compact - exceeds model context limit"
              : "Session too large to compact - context exceeds model limit even after stripping media",
          }).toObject()
          processor.message.finish = "error"
          yield* session.updateMessage(processor.message)
          return "stop"
        }

        if (result === "continue" && input.auto) {
          if (replay) {
            const original = replay.info as MessageV2.User
            const replayMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: original.agent,
              model: original.model,
              format: original.format,
              tools: original.tools,
              system: original.system,
              variant: original.variant,
            })
            for (const part of replay.parts) {
              if (part.type === "compaction") continue
              const replayPart =
                part.type === "file" && MessageV2.isMedia(part.mime)
                  ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                  : part
              yield* session.updatePart({
                ...replayPart,
                id: PartID.ascending(),
                messageID: replayMsg.id,
                sessionID: input.sessionID,
              })
            }
          }

          if (!replay) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            let text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            const todos = Todo.get(input.sessionID)
            const todoInjection = Todo.formatForInjection(todos)
            if (todoInjection) {
              text += "\n\n" + todoInjection
            }
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }

        if (processor.message.error) return "stop"
        if (result === "continue") {
          // Reload memory snapshots after compaction to capture any writes
          if (MemoryStore.isInitialized()) {
            yield* Effect.promise(() => MemoryStore.load())
          }
          yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
        }
        return result
      })

      const create = Effect.fn("SessionCompaction.create")(function* (input: {
        sessionID: SessionID
        agent: string
        model: { providerID: ProviderID; modelID: ModelID }
        auto: boolean
        overflow?: boolean
      }) {
        const msg = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: input.model,
          sessionID: input.sessionID,
          agent: input.agent,
          time: { created: Date.now() },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: msg.sessionID,
          type: "compaction",
          auto: input.auto,
          overflow: input.overflow,
        })
      })

      return Service.of({
        isOverflow,
        prune,
        process: processCompaction,
        create,
      })
    }),
  )

  export const defaultLayer = Layer.unwrap(
    Effect.sync(() =>
      layer.pipe(
        Layer.provide(Session.defaultLayer),
        Layer.provide(SessionProcessor.defaultLayer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(Bus.layer),
        Layer.provide(Config.defaultLayer),
      ),
    ),
  )

  const { runPromise, runPromiseExit } = makeRuntime(Service, defaultLayer)

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    return runPromise((svc) => svc.isOverflow(input))
  }

  export async function prune(input: { sessionID: SessionID }) {
    return runPromise((svc) => svc.prune(input))
  }

  export async function process(input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    abort: AbortSignal
    auto: boolean
    overflow?: boolean
  }) {
    const exit = await runPromiseExit((svc) => svc.process(input), { signal: input.abort })
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterrupts(exit.cause) && input.abort.aborted) return "stop"
      throw Cause.squash(exit.cause)
    }
    return exit.value
  }

  export const create = fn(
    z.object({
      sessionID: SessionID.zod,
      agent: z.string(),
      model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
      auto: z.boolean(),
      overflow: z.boolean().optional(),
    }),
    (input) => runPromise((svc) => svc.create(input)),
  )
}
