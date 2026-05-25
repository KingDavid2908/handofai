import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { MemoryRouter } from "./router"
import { MemoryStore } from "./memory-store"
import type { MemoryCategory, MemoryType } from "./backends/backend"

const log = Log.create({ service: "memory-auto-save" })

const SMART_PROMPT = `You are a memory extraction assistant. Review the conversation turn below and extract 0-3 concise facts worth remembering for future sessions.

Rules:
- Only extract information that would be useful across sessions (preferences, decisions, project context, user details)
- Do NOT extract generic chat, greetings, or temporary technical details
- Return ONLY a JSON array of strings. Example: ["User prefers TypeScript", "Project uses Bun"]
- If nothing is worth remembering, return: []`

const EVERYTHING_PROMPT = `You are a memory extraction assistant. Review the conversation turn below and summarize it into 1-3 concise facts.

Rules:
- Extract key information, decisions, and context
- Return ONLY a JSON array of strings. Example: ["User asked about memory system", "Project uses handofai"]`

const CATEGORY_PROMPT = `Classify this fact into exactly ONE category. Return ONLY the category name.

Categories:
- user_preferences: User's personal preferences, habits, or choices about themselves (e.g., "I prefer TypeScript", "I use dark mode")
- project_knowledge: Facts about the project, tech stack, architecture, or goals (e.g., "Project uses Bun", "API is REST")
- code_patterns: Coding conventions, patterns, or style preferences (e.g., "Use async/await", "Prefer functional style")
- errors: Errors, bugs, failures, or fixes discussed (e.g., "Fixed null reference error", "API returns 500")

Fact: "{fact}"
Category:`

async function getSaveModel(sessionModel: { providerID: string; modelID: string }) {
  const cfg = await Config.getGlobal().catch(() => ({} as any))
  const saveModelCfg = cfg.memory?.save_model

  if (saveModelCfg && !saveModelCfg.auto && saveModelCfg.provider_id && saveModelCfg.model_id) {
    const { providerID, modelID } = Provider.parseModel(`${saveModelCfg.provider_id}/${saveModelCfg.model_id}`)
    const model = await Provider.getModel(providerID, modelID).catch(() => null)
    if (model) return model
  }

  const { providerID, modelID } = Provider.parseModel(`${sessionModel.providerID}/${sessionModel.modelID}`)
  return Provider.getModel(providerID, modelID).catch(() => null)
}

async function formatLastTurn(sessionID: SessionID): Promise<string> {
  const messages: MessageV2.WithParts[] = []
  for await (const msg of MessageV2.stream(sessionID)) {
    messages.unshift(msg)
  }

  const recent = messages.slice(-4)
  const lines: string[] = []

  for (const msg of recent) {
    const role = msg.info.role === "user" ? "User" : "Assistant"
    const textParts = msg.parts
      .filter((p): p is MessageV2.TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")
    if (textParts.trim()) {
      lines.push(`${role}: ${textParts.trim()}`)
    }
  }

  return lines.join("\n\n")
}

async function formatLastTurnWithParts(sessionID: SessionID): Promise<MessageV2.WithParts[]> {
  const messages: MessageV2.WithParts[] = []
  for await (const msg of MessageV2.stream(sessionID)) {
    messages.unshift(msg)
  }
  return messages.slice(-4)
}

function parseFacts(text: string): string[] {
  try {
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) return []
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return []
    return parsed.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
  } catch {
    return []
  }
}

function detectTarget(fact: string): "user" | "memory" {
  const userPatterns = [
    /i prefer/i,
    /my /i,
    /i use/i,
    /i like/i,
    /i want/i,
    /i need/i,
    /user /i,
  ]
  for (const p of userPatterns) {
    if (p.test(fact)) return "user"
  }
  return "memory"
}

async function detectCategory(fact: string, sessionModel: { providerID: string; modelID: string }): Promise<MemoryCategory> {
  try {
    const model = await getSaveModel(sessionModel)
    if (!model) return "project_knowledge"

    const language = await Provider.getLanguage(model)
    const { streamText } = await import("ai")

    const result = streamText({
      model: language,
      messages: [
        {
          role: "user",
          content: CATEGORY_PROMPT.replace("{fact}", fact),
        },
      ],
    })

    let response = ""
    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        response += chunk.text
      }
    }

    const cleaned = response.trim().toLowerCase()
    if (cleaned.includes("user_preference")) return "user_preferences"
    if (cleaned.includes("project_knowledge")) return "project_knowledge"
    if (cleaned.includes("code_pattern")) return "code_patterns"
    if (cleaned.includes("error")) return "errors"
    return "project_knowledge"
  } catch {
    return "project_knowledge"
  }
}

function detectMediaType(mime: string): MemoryType {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("audio/")) return "audio"
  return "document"
}

export namespace MemoryAutoSave {
  export async function run(sessionID: SessionID, sessionModel: { providerID: string; modelID: string }) {
    try {
      const cfg = await Config.getGlobal().catch(() => ({} as any))
      const memCfg = cfg.memory
      if (memCfg && memCfg.enabled === false) return
      if (memCfg && memCfg.review_enabled === false) return

      const behavior = memCfg?.save_behavior ?? "smart"
      const customPrompt = memCfg?.save_prompt

      const context = await formatLastTurn(sessionID)
      if (!context.trim()) return

      const model = await getSaveModel(sessionModel)
      if (!model) {
        log.warn("no model available for auto-save")
        return
      }

      const language = await Provider.getLanguage(model)
      const { streamText } = await import("ai")

      const systemPrompt = customPrompt
        ? `${customPrompt}\n\nReturn ONLY a JSON array of strings. If nothing to save, return [].`
        : behavior === "smart"
          ? SMART_PROMPT
          : EVERYTHING_PROMPT

      const result = streamText({
        model: language,
        messages: [
          {
            role: "user",
            content: `${systemPrompt}\n\nConversation turn:\n\n${context}`,
          },
        ],
      })

      let response = ""
      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") {
          response += chunk.text
        }
      }

      const facts = parseFacts(response)
      if (facts.length === 0) {
        log.info("auto-save: nothing to save", { sessionID, behavior })
        return
      }

      // Save text facts with LLM-categorized routing
      const router = await MemoryStore.getRouter()
      for (const fact of facts) {
        const target = detectTarget(fact)
        const category = await detectCategory(fact, sessionModel)
        await router.add({
          content: fact,
          type: "text",
          category,
          target,
          source: "auto-save",
        })
      }

      // Extract and save media from conversation turns
      const recentMessages = await formatLastTurnWithParts(sessionID)
      for (const msg of recentMessages) {
        for (const part of msg.parts) {
          if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
            const mediaType = detectMediaType(part.mime)
            await router.add({
              content: part.url,
              type: mediaType,
              category: mediaType as MemoryCategory,
              target: "memory",
              source: "auto-save",
              metadata: { filename: part.filename, mime: part.mime },
            })
          }
        }
      }

      log.info("auto-save: saved", { sessionID, count: facts.length, behavior })
    } catch (err) {
      log.error("auto-save failed", { sessionID, error: err })
    }
  }
}
