import { Log } from "@/util/log"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Config } from "@/config/config"
import { ProviderID, ModelID } from "@/provider/schema"
import type { SessionID } from "@/session/schema"
import type { Agent } from "@/agent/agent"
import { MEMORY_REVIEW_PROMPT, SKILL_REVIEW_PROMPT, COMBINED_REVIEW_PROMPT } from "./prompts"
import { MemoryStore } from "@/memory/memory-store"
import { Skill } from "@/skill"

const log = Log.create({ service: "background-review" })

export namespace BackgroundReview {
  export async function execute(input: {
    sessionID: SessionID
    model: { providerID: string; modelID: string }
    agent: Agent.Info
    reviewMemory: boolean
    reviewSkills: boolean
  }) {
    const prompt = input.reviewMemory && input.reviewSkills
      ? COMBINED_REVIEW_PROMPT
      : input.reviewMemory
        ? MEMORY_REVIEW_PROMPT
        : SKILL_REVIEW_PROMPT

    const cfg = await Config.get()
    if (cfg.memory?.review_enabled === false) return

    log.info("starting background review", {
      sessionID: input.sessionID,
      reviewMemory: input.reviewMemory,
      reviewSkills: input.reviewSkills,
    })

    let reviewSessionID: SessionID | undefined

    try {
      const reviewSession = await Session.create({
        parentID: input.sessionID,
        title: "Background Review",
        permission: input.agent.permission,
      })

      reviewSessionID = reviewSession.id as SessionID

      await SessionPrompt.prompt({
        sessionID: reviewSessionID,
        model: {
          providerID: input.model.providerID as ProviderID,
          modelID: input.model.modelID as ModelID,
        },
        agent: input.agent.name,
        parts: [{ type: "text", text: prompt }],
        tools: {
          memory: input.reviewMemory,
          skill_manage: input.reviewSkills,
          lesson: true,
        },
      })

      log.info("background review complete", { sessionID: input.sessionID })

      if (MemoryStore.isInitialized()) {
        await MemoryStore.load()
      }
      await Skill.reload().catch(() => {})
    } catch (e) {
      log.error("background review failed", { sessionID: input.sessionID, error: e })
    } finally {
      if (reviewSessionID) {
        await Session.remove(reviewSessionID).catch(() => {})
      }
    }
  }
}
