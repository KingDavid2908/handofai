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

const REVIEW_PROMPT = `Review this conversation and save any important information to memory. Focus on:
1. User preferences and expectations
2. Personal details about the user
3. Important technical decisions and context
4. Project goals and progress
5. Any unresolved items

Use the memory tool to save user-related facts to "user" target, and project/task notes to "memory" target.
Keep entries concise. Only save information that would be useful in future sessions.
If nothing worth remembering was discussed, do not call the memory tool.`

export namespace MemoryNudge {
  const sessions = new Map<string, { turns: number; pending: boolean }>()

  export function incrementTurn(sessionID: string) {
    const state = sessions.get(sessionID) ?? { turns: 0, pending: false }
    state.turns++
    sessions.set(sessionID, state)
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

  export async function review(input: {
    sessionID: SessionID
    model: { providerID: string; modelID: string }
    agent: Agent.Info
  }) {
    const state = sessions.get(input.sessionID)
    if (!state || state.pending) return

    state.pending = true
    log.info("starting memory review", { sessionID: input.sessionID })

    try {
      const config = await Config.get()
      const nudgeInterval = config.memory?.nudge_interval ?? 10

      const msgs = await Session.messages({ sessionID: input.sessionID })
      const recentMsgs = msgs.slice(-Math.min(msgs.length, 20))

      const reviewSession = await Session.create({
        parentID: input.sessionID,
        title: "Memory Review",
        permission: input.agent.permission,
      })

      const result = await SessionPrompt.prompt({
        sessionID: reviewSession.id,
        model: {
          providerID: input.model.providerID as ProviderID,
          modelID: input.model.modelID as ModelID,
        },
        agent: input.agent.name,
        parts: [{ type: "text", text: REVIEW_PROMPT }],
        tools: { memory: true },
      })

      reset(input.sessionID)
      log.info("memory review complete", { sessionID: input.sessionID })

      await Session.remove(reviewSession.id)
    } catch (e) {
      log.error("memory review failed", { sessionID: input.sessionID, error: e })
      reset(input.sessionID)
    }
  }
}
