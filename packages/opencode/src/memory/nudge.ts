import { Log } from "@/util/log"
import { MemoryStore } from "./memory-store"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { SessionID } from "../session/schema"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { SessionPrompt } from "../session/prompt"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import { ProviderID, ModelID } from "../provider/schema"

const log = Log.create({ service: "memory-nudge" })

async function buildReviewPrompt(): Promise<string> {
  const cfg = await Config.getGlobal().catch(() => ({} as any))
  const memCfg = cfg.memory ?? {}
  const behavior = memCfg.save_behavior ?? "smart"
  const customPrompt = memCfg.save_prompt

  const backends = memCfg.backends ?? {}
  const backendLines: string[] = []
  if (backends.local?.enabled !== false) backendLines.push("- Local (MEMORY.md / USER.md): quick notes, project context")
  if (backends.supermemory?.enabled) {
    const useFor = backends.supermemory.use_for?.join(", ") || "general"
    backendLines.push(`- Supermemory: ${useFor}`)
  }
  if (backends.graphlit?.enabled) {
    const useFor = backends.graphlit.use_for?.join(", ") || "general"
    backendLines.push(`- Graphlit: ${useFor}`)
  }

  return `Review this conversation and save any important information to memory.

SAVE BEHAVIOR: ${behavior === "everything" ? "Save everything worth remembering to all configured backends." : "Only save information that would be useful in future sessions. Be selective."}
${customPrompt ? `USER PREFERENCE: ${customPrompt}` : ""}

Active backends:
${backendLines.join("\n") || "- Local only"}

Focus on:
1. User preferences and expectations
2. Personal details about the user
3. Important technical decisions and context
4. Project goals and progress
5. Any unresolved items
6. Permission corrections — did the user reject or correct a tool usage?

Use the memory tool to save user-related facts to "user" target, and project/task notes to "memory" target.
Keep entries concise. ${behavior === "smart" ? "Only save information that would be useful in future sessions." : "Save all important information."}`
}

async function formatConversation(sessionID: SessionID, behavior: string): Promise<string> {
  const messages: MessageV2.WithParts[] = []
  for await (const msg of MessageV2.stream(sessionID)) {
    messages.unshift(msg)
  }

  const lines: string[] = []
  for (const msg of messages) {
    const role = msg.info.role === "user" ? "User" : "Assistant"
    const textParts = msg.parts
      .filter((p): p is MessageV2.TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")

    if (behavior === "smart" && msg.info.role === "assistant") {
      // For smart mode, only include assistant summaries, not full tool outputs
      const toolResults = msg.parts
        .filter((p): p is MessageV2.ToolPart => p.type === "tool" && p.state.status === "completed")
        .map((p) => {
          const output = p.state.status === "completed" ? p.state.output : ""
          return `[Tool: ${p.tool}] ${(output || "completed").slice(0, 200)}`
        })
        .join("\n")

      if (textParts.trim()) lines.push(`${role}: ${textParts.trim()}`)
      if (toolResults) lines.push(toolResults)
    } else {
      // Everything mode: include full conversation
      if (textParts.trim()) lines.push(`${role}: ${textParts.trim()}`)

      const toolResults = msg.parts
        .filter((p): p is MessageV2.ToolPart => p.type === "tool" && p.state.status === "completed")
        .map((p) => {
          const output = p.state.status === "completed" ? p.state.output : ""
          return `[Tool: ${p.tool}] ${output || "completed"}`
        })
        .join("\n")
      if (toolResults) lines.push(toolResults)
    }
  }

  return lines.join("\n\n")
}

export namespace MemoryNudge {
  const sessions = new Map<string, {
    turns: number
    pending: boolean
    skillTurns: number
  }>()

  export function incrementTurn(sessionID: string) {
    const state = sessions.get(sessionID) ?? { turns: 0, pending: false, skillTurns: 0 }
    state.turns++
    sessions.set(sessionID, state)
  }

  export function incrementSkillTurns(sessionID: string) {
    const state = sessions.get(sessionID) ?? { turns: 0, pending: false, skillTurns: 0 }
    state.skillTurns++
    sessions.set(sessionID, state)
  }

  export function resetSkillTurns(sessionID: string) {
    const state = sessions.get(sessionID)
    if (state) state.skillTurns = 0
  }

  export function shouldTriggerSkillReview(sessionID: string, interval: number): boolean {
    const state = sessions.get(sessionID)
    if (!state) return false
    if (state.pending) return false
    return state.skillTurns >= interval
  }

  export function shouldTrigger(sessionID: string, interval: number): boolean {
    const state = sessions.get(sessionID)
    if (!state) return false
    if (state.pending) return false
    return state.turns >= interval
  }

  export function reset(sessionID: string) {
    const state = sessions.get(sessionID)
    if (state) {
      state.turns = 0
      state.pending = false
    }
  }

  export function cleanup(sessionID: string) {
    sessions.delete(sessionID)
  }

  export async function review(input: {
    sessionID: SessionID
    model: { providerID: string; modelID: string }
    agent: Agent.Info
  }) {
    const state = sessions.get(input.sessionID)
    if (!state || state.pending) return

    state.pending = true
    log.info("starting memory review", { sessionID: input.sessionID })

    let reviewSessionID: SessionID | undefined

    try {
      const reviewSession = await Session.create({
        parentID: input.sessionID,
        title: "Memory Review",
        permission: input.agent.permission,
      })

      reviewSessionID = reviewSession.id as SessionID

      const prompt = await buildReviewPrompt()

      const result = await SessionPrompt.prompt({
        sessionID: reviewSessionID,
        model: {
          providerID: input.model.providerID as ProviderID,
          modelID: input.model.modelID as ModelID,
        },
        agent: input.agent.name,
        parts: [{ type: "text", text: prompt }],
        tools: { memory: true },
      })

      // After review, sync full conversation to Supermemory (if configured)
      await syncConversationToSupermemory(input.sessionID, input.model)

      log.info("memory review complete", { sessionID: input.sessionID })
    } catch (e) {
      log.error("memory review failed", { sessionID: input.sessionID, error: e })
    } finally {
      if (reviewSessionID) {
        await Session.remove(reviewSessionID).catch(() => {})
      }
      reset(input.sessionID)
    }
  }

  async function syncConversationToSupermemory(sessionID: SessionID, model: { providerID: string; modelID: string }) {
    try {
      const cfg = await Config.getGlobal().catch(() => ({} as any))
      const memCfg = cfg.memory ?? {}
      const behavior = memCfg.save_behavior ?? "smart"

      // Check if Supermemory is enabled and has "conversations" in use_for
      const smCfg = memCfg.backends?.supermemory
      if (!smCfg?.enabled) return
      if (!smCfg.use_for?.includes("conversations")) return

      const conversationText = await formatConversation(sessionID, behavior)
      if (!conversationText.trim()) return

      const router = await MemoryStore.getRouter()
      await router.add({
        content: conversationText,
        type: "text",
        category: "conversations",
        target: "memory",
        source: "nudge",
      })

      log.info("conversation synced to supermemory", { sessionID, behavior })
    } catch (err) {
      log.error("conversation sync failed", { sessionID, error: err })
    }
  }
}
