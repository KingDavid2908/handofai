import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./websearch.txt"
import { abortAfterAny } from "../util/abort"
import { WebProvider } from "./web-provider"

export const WebSearchTool = Tool.define("websearch", async () => {
  return {
    get description() {
      return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
    },
    parameters: z.object({
      query: z.string().describe("Websearch query"),
      numResults: z.number().optional().describe("Number of search results to return (default: 8)"),
      livecrawl: z
        .enum(["fallback", "preferred"])
        .optional()
        .describe(
          "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
        ),
      type: z
        .enum(["auto", "fast", "deep"])
        .optional()
        .describe(
          "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
        ),
      contextMaxCharacters: z
        .number()
        .optional()
        .describe("Maximum characters for context string optimized for LLMs (default: 10000)"),
    }),
    async execute(params, ctx) {
      await ctx.ask({
        permission: "websearch",
        patterns: [params.query],
        always: ["*"],
        metadata: {
          query: params.query,
          numResults: params.numResults,
          livecrawl: params.livecrawl,
          type: params.type,
          contextMaxCharacters: params.contextMaxCharacters,
        },
      })

      const chain = await WebProvider.getSearchChain()
      const provider = chain[0]

      // Exa primary path (default) — uses MCP for richer params
      if (provider === "exa") {
        try {
          return await searchExa(params, ctx)
        } catch {
          // Fall through to fallback chain
        }
        // Remove exa from chain for fallback
        chain.shift()
        if (chain.length === 0) {
          throw new Error("Search failed: Exa error and no fallback providers configured")
        }
      }

      return WebProvider.searchWithFallback(
        params.query,
        ctx.abort,
        {
          numResults: params.numResults,
          timeout: 25000,
        },
      )
    },
  }
})

async function searchExa(
  params: { query: string; numResults?: number; livecrawl?: string; type?: string; contextMaxCharacters?: number },
  ctx: { abort: AbortSignal },
) {
  const { signal, clearTimeout } = abortAfterAny(25000, ctx.abort)

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query: params.query,
        type: params.type || "auto",
        numResults: params.numResults || 8,
        livecrawl: params.livecrawl || "fallback",
        contextMaxCharacters: params.contextMaxCharacters,
      },
    },
  })

  const response = await fetch("https://mcp.exa.ai/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body,
    signal,
  })

  clearTimeout()

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Search error (${response.status}): ${text}`)
  }

  const text = await response.text()
  const lines = text.split("\n")
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue
    const data = JSON.parse(line.slice(6))
    if (data.result?.content?.length > 0) {
      return {
        output: data.result.content[0].text,
        title: `Web search: ${params.query}`,
        metadata: {},
      }
    }
  }

  return {
    output: "No search results found. Please try a different query.",
    title: `Web search: ${params.query}`,
    metadata: {},
  }
}
