import { Log } from "../util/log"

const log = Log.create({ service: "model-enrich" })

interface OpenRouterModel {
  id: string
  name?: string
  description?: string
  context_length?: number
  architecture?: {
    modality?: string
    input_modalities?: string[]
    output_modalities?: string[]
  }
  pricing?: {
    prompt?: string
    completion?: string
    input_cache_read?: string
    input_cache_write?: string
  }
  top_provider?: {
    context_length?: number
    max_completion_tokens?: number
  }
  supported_parameters?: string[]
  reasoning?: {
    mandatory?: boolean
    default_enabled?: boolean
  }
}

export interface EnrichedModel {
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number }
  limit?: { context: number; output: number }
  modalities?: { input: ("text" | "audio" | "image" | "video" | "pdf")[]; output: ("text" | "audio" | "image" | "video" | "pdf")[] }
  reasoning?: boolean
  tool_call?: boolean
  temperature?: boolean
}

function parseCost(val?: string): number {
  if (!val) return 0
  return parseFloat(val) || 0
}

function parseModalities(modality?: string): { input: ("text" | "audio" | "image" | "video" | "pdf")[]; output: ("text" | "audio" | "image" | "video" | "pdf")[] } | undefined {
  if (!modality) return undefined
  const [inMod, outMod] = modality.split("->")
  const valid = ["text", "audio", "image", "video", "pdf"] as const
  const parse = (s: string) =>
    s.split("+").map((m) => m.trim()).filter((m): m is (typeof valid)[number] => valid.includes(m as any))
  return {
    input: inMod ? parse(inMod) : ["text"],
    output: outMod ? parse(outMod) : ["text"],
  }
}

function parseContextLength(m: OpenRouterModel): number {
  return m.context_length ?? m.top_provider?.context_length ?? 128000
}

function parseMaxCompletion(m: OpenRouterModel): number {
  return m.top_provider?.max_completion_tokens ?? 16384
}

function toEnriched(m: OpenRouterModel): EnrichedModel {
  const cost = m.pricing
    ? {
        input: parseCost(m.pricing.prompt),
        output: parseCost(m.pricing.completion),
        cache_read: parseCost(m.pricing.input_cache_read),
        cache_write: parseCost(m.pricing.input_cache_write),
      }
    : undefined

  const params = m.supported_parameters ?? []
  return {
    cost,
    limit: {
      context: parseContextLength(m),
      output: parseMaxCompletion(m),
    },
    modalities: parseModalities(m.architecture?.modality),
    reasoning: m.reasoning?.default_enabled ?? params.includes("reasoning"),
    tool_call: params.includes("tools"),
    temperature: params.includes("temperature"),
  }
}

async function fetchExact(id: string): Promise<OpenRouterModel | null> {
  const url = `https://openrouter.ai/api/v1/models/${encodeURIComponent(id)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
  if (!res.ok) return null
  const json = await res.json() as OpenRouterModel | { data: OpenRouterModel }
  const model = "data" in json ? json.data : json
  if (!model || model.id !== id) return null
  return model
}

async function fetchSearch(id: string): Promise<OpenRouterModel | null> {
  const url = `https://openrouter.ai/api/v1/models?q=${encodeURIComponent(id)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
  if (!res.ok) return null
  const json = await res.json() as { data: OpenRouterModel[] }
  if (!json.data?.length) return null

  const match = json.data.find((m) => m.id === id)
  if (match) return match

  for (const m of json.data) {
    const needle = id.split("/").pop()?.toLowerCase() ?? id.toLowerCase()
    if (m.id.toLowerCase().includes(needle)) return m
  }
  return null
}

async function enrichOne(id: string): Promise<EnrichedModel | null> {
  const clean = id.split("/").pop() ?? id
  const apiId = clean.includes(":") ? clean : id

  try {
    const exact = await fetchExact(apiId)
    if (exact) return toEnriched(exact)

    const search = await fetchSearch(apiId)
    if (search) return toEnriched(search)
  } catch (e) {
    log.warn("openrouter fetch failed", { id, error: e })
  }
  return null
}

async function runBatch(items: { apiId: string; localId: string }[], result: Record<string, EnrichedModel>): Promise<void> {
  const promises = items.map(async ({ apiId, localId }) => {
    const enriched = await enrichOne(apiId)
    if (enriched) result[localId] = enriched
  })
  await Promise.allSettled(promises)
}

export async function enrichModels(models: Record<string, { id: string }>): Promise<Record<string, EnrichedModel>> {
  const result: Record<string, EnrichedModel> = {}
  const entries = Object.entries(models).map(([localId, m]) => ({
    localId,
    apiId: m?.id ?? localId,
  }))

  const batchSize = 10
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize)
    await runBatch(batch, result)
  }

  log.info("enrichment complete", { total: entries.length, enriched: Object.keys(result).length })
  return result
}
