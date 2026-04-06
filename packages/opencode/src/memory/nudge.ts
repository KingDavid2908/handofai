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
6. Permission corrections — did the user reject or correct a tool usage?

Use the memory tool to save user-related facts to "user" target, and project/task notes to "memory" target.
Keep entries concise. Only save information that would be useful in future sessions.
If nothing worth remembering was discussed, do not call the memory tool.`

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

      const result = await SessionPrompt.prompt({
        sessionID: reviewSessionID,
        model: {
          providerID: input.model.providerID as ProviderID,
          modelID: input.model.modelID as ModelID,
        },
        agent: input.agent.name,
        parts: [{ type: "text", text: REVIEW_PROMPT }],
        tools: { memory: true },
      })

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
}
