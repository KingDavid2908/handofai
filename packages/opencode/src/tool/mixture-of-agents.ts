import z from "zod"
import { Tool } from "./tool"
import { Provider } from "../provider/provider"
import { ProviderID, ModelID } from "../provider/schema"
import { streamText } from "ai"
import { Session } from "../session"
import { PartID } from "../session/schema"
import { errorMessage } from "../util/error"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import path from "path"
import Decimal from "decimal.js"

const AGGREGATOR_SYSTEM_PROMPT = `You have been provided with a set of responses from various open-source models to the latest user query. Your task is to synthesize these responses into a single, high-quality response. It is crucial to critically evaluate the information provided in these responses, recognizing that some of it may be biased or incorrect. Your response should not simply replicate the given answers but should offer a refined, accurate, and comprehensive reply to the instruction. Ensure your response is well-structured, coherent, and adheres to the highest standards of accuracy and reliability.

Responses from models:`

const RETRY_DELAYS = [2000, 4000, 8000, 16000, 32000, 60000]
const MIN_SUCCESSFUL_REFERENCES = 1

type MoaModel = { providerID: string; modelID: string; variant?: string }

type MoaConfig = {
  reference_models: MoaModel[]
  aggregator_model: MoaModel | null
}

async function loadMoaConfig(): Promise<MoaConfig> {
  const filePath = path.join(Global.Path.state, "model.json")
  try {
    const data = await Filesystem.readJson(filePath) as any
    return {
      reference_models: Array.isArray(data.moa_reference_models) ? data.moa_reference_models : [],
      aggregator_model: data.moa_aggregator_model && typeof data.moa_aggregator_model === "object" ? data.moa_aggregator_model : null,
    }
  } catch {
    return { reference_models: [], aggregator_model: null }
  }
}

function calcCost(model: Provider.Model, usage: any): number {
  const safe = (v: number) => Number.isFinite(v) ? v : 0
  const inputTokens = safe(usage.inputTokens ?? 0)
  const outputTokens = safe(usage.outputTokens ?? 0)
  const reasoningTokens = safe(usage.reasoningTokens ?? 0)
  const cacheRead = safe(usage.cachedInputTokens ?? 0)
  const cacheWrite = safe(usage.cacheCreationInputTokens ?? 0)
  const adjustedInput = safe(inputTokens - cacheRead - cacheWrite)
  const costInfo = model.cost?.experimentalOver200K && adjustedInput + cacheRead > 200_000
    ? model.cost.experimentalOver200K
    : model.cost
  if (!costInfo) return 0
  return safe(
    new Decimal(0)
      .add(new Decimal(adjustedInput).mul(costInfo.input ?? 0).div(1_000_000))
      .add(new Decimal(outputTokens).mul(costInfo.output ?? 0).div(1_000_000))
      .add(new Decimal(cacheRead).mul(costInfo.cache?.read ?? 0).div(1_000_000))
      .add(new Decimal(cacheWrite).mul(costInfo.cache?.write ?? 0).div(1_000_000))
      .add(new Decimal(reasoningTokens).mul(costInfo.output ?? 0).div(1_000_000))
      .toNumber()
  )
}

async function runReferenceModelSafe(
  model: MoaModel,
  prompt: string,
): Promise<{ model: string; response: string; success: boolean; cost: number; modelInfo: Provider.Model }> {
  const modelStr = `${model.providerID}/${model.modelID}${model.variant ? `/${model.variant}` : ""}`
  for (let attempt = 0; attempt < RETRY_DELAYS.length + 1; attempt++) {
    try {
      const info = await Provider.getModel(ProviderID.make(model.providerID), ModelID.make(model.modelID))
      const lang = await Provider.getLanguage(info)
      const result = streamText({
        model: lang,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.6,
      })
      let text = ""
      let usage: any = null
      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") text += chunk.text
        if (chunk.type === "finish") usage = chunk.totalUsage
      }
      if (!text && attempt < RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
        continue
      }
      const cost = usage ? calcCost(info, usage) : 0
      return { model: modelStr, response: text, success: true, cost, modelInfo: info }
    } catch {
      if (attempt < RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
      } else {
        return { model: modelStr, response: `Failed after ${RETRY_DELAYS.length + 1} attempts`, success: false, cost: 0, modelInfo: {} as Provider.Model }
      }
    }
  }
  return { model: modelStr, response: "Failed", success: false, cost: 0, modelInfo: {} as Provider.Model }
}

async function runAggregatorModel(
  model: MoaModel,
  systemPrompt: string,
  prompt: string,
): Promise<{ response: string; cost: number; modelInfo: Provider.Model }> {
  for (let attempt = 0; attempt < RETRY_DELAYS.length + 1; attempt++) {
    try {
      const info = await Provider.getModel(ProviderID.make(model.providerID), ModelID.make(model.modelID))
      const lang = await Provider.getLanguage(info)
      const result = streamText({
        model: lang,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
      })
      let text = ""
      let usage: any = null
      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") text += chunk.text
        if (chunk.type === "finish") usage = chunk.totalUsage
      }
      if (!text && attempt < RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
        continue
      }
      const cost = usage ? calcCost(info, usage) : 0
      return { response: text, cost, modelInfo: info }
    } catch {
      if (attempt < RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
      } else {
        throw new Error("Aggregator model failed after all retry attempts")
      }
    }
  }
  throw new Error("Aggregator model failed")
}

export const MixtureOfAgentsTool = Tool.define("mixture_of_agents", {
  description: "Route a hard problem through multiple frontier LLMs collaboratively. Uses 2-5 reference models + 1 aggregator model — use sparingly for genuinely difficult problems. Best for: complex math, advanced algorithms, multi-step analytical reasoning.",
  parameters: z.object({
    user_prompt: z.string().describe("The complex query or problem to solve using multiple AI models"),
  }),
  async execute(params, ctx) {
    const config = await loadMoaConfig()

    if (config.reference_models.length < 2) {
      throw new Error(
        "Mixture of Agents requires at least 2 reference models. Configure them with /moa first.",
      )
    }
    if (!config.aggregator_model) {
      throw new Error(
        "Mixture of Agents requires an aggregator model. Configure it with /moa first.",
      )
    }

    const refModels = config.reference_models
    const aggModel = config.aggregator_model

    const refModelNames = refModels.map(m => `${m.providerID}/${m.modelID}${m.variant ? `/${m.variant}` : ""}`)
    const aggModelName = `${aggModel.providerID}/${aggModel.modelID}${aggModel.variant ? `/${aggModel.variant}` : ""}`

    await ctx.ask({
      permission: "moa",
      patterns: ["*"],
      always: [],
      metadata: {
        reference_models: refModelNames,
        aggregator_model: aggModelName,
        reference_count: refModels.length,
      },
    })

    const partIDs = refModels.map(() => PartID.ascending())
    const aggPartID = PartID.ascending()

    const refResults = await Promise.all(
      refModels.map(async (m, i) => {
        const modelStr = `${m.providerID}/${m.modelID}${m.variant ? `/${m.variant}` : ""}`
        const startTime = Date.now()
        await Session.updatePart({
          id: partIDs[i],
          messageID: ctx.messageID,
          sessionID: ctx.sessionID,
          type: "tool",
          tool: "mixture_of_agents",
          callID: partIDs[i],
          state: {
            status: "running",
            input: { model: modelStr },
            title: `[Running] Reference: ${modelStr}`,
            time: { start: startTime },
          },
        })
        const result = await runReferenceModelSafe(m, params.user_prompt)
        const endTime = Date.now()
        if (result.success) {
          await Session.updatePart({
            id: partIDs[i],
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: "mixture_of_agents",
            callID: partIDs[i],
            state: {
              status: "completed",
              input: { model: modelStr },
              output: result.response,
              title: `[Complete] Reference: ${modelStr}`,
              metadata: { model: modelStr, cost: result.cost },
              time: { start: startTime, end: endTime },
            },
          })
        } else {
          await Session.updatePart({
            id: partIDs[i],
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: "mixture_of_agents",
            callID: partIDs[i],
            state: {
              status: "error",
              input: { model: modelStr },
              error: result.response,
              title: `[Failed] Reference: ${modelStr}`,
              time: { start: startTime, end: endTime },
            },
          })
        }
        return result
      }),
    )

    const successful = refResults.filter(r => r.success)
    if (successful.length < MIN_SUCCESSFUL_REFERENCES) {
      throw new Error(
        `Insufficient successful reference models (${successful.length}/${refModels.length}). Need at least ${MIN_SUCCESSFUL_REFERENCES}.`,
      )
    }

    const aggStartTime = Date.now()
    await Session.updatePart({
      id: aggPartID,
      messageID: ctx.messageID,
      sessionID: ctx.sessionID,
      type: "tool",
      tool: "mixture_of_agents",
      callID: aggPartID,
      state: {
        status: "running",
        input: { model: aggModelName },
        title: `[Running] Aggregator: ${aggModelName}`,
        time: { start: aggStartTime },
      },
    })

    const successfulResponses = successful.map((r, i) => `${i + 1}. ${r.response}`)
    const aggregatorPrompt = `${AGGREGATOR_SYSTEM_PROMPT}\n\n${successfulResponses.join("\n")}`

    const aggResult = await runAggregatorModel(aggModel, aggregatorPrompt, params.user_prompt)

    const aggEndTime = Date.now()
    await Session.updatePart({
      id: aggPartID,
      messageID: ctx.messageID,
      sessionID: ctx.sessionID,
      type: "tool",
      tool: "mixture_of_agents",
      callID: aggPartID,
      state: {
        status: "completed",
        input: { model: aggModelName },
        output: aggResult.response,
        title: `[Complete] Aggregator: ${aggModelName}`,
        metadata: { model: aggModelName, cost: aggResult.cost },
        time: { start: aggStartTime, end: aggEndTime },
      },
    })

    const totalCost = successful.reduce((sum, r) => sum + r.cost, 0) + aggResult.cost

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const projectDir = Instance.directory

    const discussionMd = [
      `# Mixture of Agents — Discussion`,
      ``,
      `**Prompt:** ${params.user_prompt}`,
      ``,
      `**Models Used:**`,
      ...refModelNames.map((n, i) => `  ${i + 1}. ${n}`),
      `  Aggregator: ${aggModelName}`,
      ``,
      `---`,
      ``,
      ...successful.flatMap((r, i) => [
        `## ${r.model}`,
        ``,
        r.response,
        ``,
        `---`,
        ``,
      ]),
    ].join("\n")

    const discussionPath = path.join(projectDir, `moa-discussion-${timestamp}.md`)
    await Filesystem.write(discussionPath, discussionMd)

    const responseMd = [
      `# Mixture of Agents — Final Response`,
      ``,
      `**Prompt:** ${params.user_prompt}`,
      ``,
      `**Aggregator:** ${aggModelName}`,
      ``,
      `---`,
      ``,
      aggResult.response,
      ``,
      `---`,
      ``,
      `**Cost Breakdown:**`,
      ...successful.map(r => `  ${r.model}: $${r.cost.toFixed(6)}`),
      `  Aggregator (${aggModelName}): $${aggResult.cost.toFixed(6)}`,
      `  **Total: $${totalCost.toFixed(6)}**`,
    ].join("\n")

    const responsePath = path.join(projectDir, `moa-response-${timestamp}.md`)
    await Filesystem.write(responsePath, responseMd)

    return {
      title: "Mixture of Agents",
      output: JSON.stringify({
        success: true,
        response: `Full discussion saved to moa-discussion-${timestamp}.md\nFinal response saved to moa-response-${timestamp}.md`,
        models_used: {
          reference_models: refModelNames,
          aggregator_model: aggModelName,
        },
        cost: totalCost,
      }, null, 2),
      metadata: {
        cost: totalCost,
        reference_count: refModels.length,
        successful_count: successful.length,
        models_used: {
          reference_models: refModelNames,
          aggregator_model: aggModelName,
        },
        discussion_file: discussionPath,
        response_file: responsePath,
      },
    }
  },
})
