import { Global } from "@/global"
import { Log } from "@/util/log"

const log = Log.create({ service: "media.hf-spaces" })

const SEARCH_LIMIT = 8

export interface SpaceResult {
  id: string
  likes: number
}

function authHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" }
  if (token) h["Authorization"] = `Bearer ${token}`
  return h
}

export async function searchForSpace(task: string, token?: string): Promise<SpaceResult[]> {
  log.info("searching", { task })

  const keywordParams = new URLSearchParams({
    search: task,
    sdk: "gradio",
    limit: String(SEARCH_LIMIT),
    full: "true",
  })

  try {
    const keywordResp = await fetch(`https://huggingface.co/api/spaces?${keywordParams}`, {
      headers: authHeaders(token),
    })
    if (keywordResp.ok) {
      const data = (await keywordResp.json()) as Array<{
        id: string
        sdk?: string
        likes?: number
      }>
      const results = data
        .filter((s) => (s.sdk ?? "").toLowerCase() === "gradio")
        .map((s) => ({ id: s.id, likes: s.likes ?? 0 }))
        .sort((a, b) => b.likes - a.likes)
      if (results.length > 0) return results
    }
  } catch (e) {
    log.error("keyword search failed", { error: e })
  }

  // Fallback to semantic search
  try {
    const semanticParams = new URLSearchParams({ q: task, sdk: "gradio", limit: String(SEARCH_LIMIT) })
    const semanticResp = await fetch(`https://huggingface.co/api/spaces/semantic-search?${semanticParams}`, {
      headers: authHeaders(token),
    })
    if (semanticResp.ok) {
      const data = (await semanticResp.json()) as Array<{
        id: string
        likes?: number
      }>
      return data
        .map((s) => ({ id: s.id, likes: s.likes ?? 0 }))
        .sort((a, b) => b.likes - a.likes)
    }
  } catch (e) {
    log.error("semantic search failed", { error: e })
  }

  return []
}

export async function fetchSpaceLikes(spaceId: string, token?: string): Promise<number> {
  try {
    const resp = await fetch(`https://huggingface.co/api/spaces/${spaceId}`, {
      headers: authHeaders(token),
    })
    if (!resp.ok) return 0
    const data = (await resp.json()) as { likes?: number }
    return data.likes ?? 0
  } catch {
    return 0
  }
}
