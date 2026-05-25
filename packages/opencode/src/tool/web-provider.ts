import path from "path"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Log } from "../util/log"

const log = Log.create({ service: "web-provider" })

export type SearchProviderID = "exa" | "tinyfish" | "tavily" | "firecrawl"
export type FetchProviderID = "direct" | "tinyfish" | "tavily" | "firecrawl"

const STATE_FILE = path.join(Global.Path.state, "web-provider.json")
const ALL_SEARCH: SearchProviderID[] = ["exa", "tinyfish", "tavily", "firecrawl"]
const ALL_FETCH: FetchProviderID[] = ["direct", "tinyfish", "tavily", "firecrawl"]
const DEFAULT_SEARCH: SearchProviderID[] = ["exa"]
const DEFAULT_FETCH: FetchProviderID[] = ["direct"]

enum ProviderType {
  SEARCH = "search",
  FETCH = "fetch",
  BOTH = "both",
}

// --- Provider Interface (mirrors MemoryBackend) ---

export interface WebProviderBackend {
  readonly id: string
  readonly name: string
  readonly type: ProviderType
  enabled: boolean
  configured: boolean
  init(): Promise<void>
  testConnection(key: string): Promise<{ success: boolean; error?: string }>
}

// --- Provider Implementations ---

class DefaultProvider implements WebProviderBackend {
  readonly id: string
  readonly name: string
  readonly type: ProviderType
  enabled = true
  configured = true

  constructor(id: string, name: string, type: ProviderType) {
    this.id = id
    this.name = name
    this.type = type
  }

  async init() {}
  async testConnection(_key: string) {
    return { success: true }
  }
}

class TinyFishProvider implements WebProviderBackend {
  readonly id = "tinyfish"
  readonly name = "TinyFish"
  readonly type = ProviderType.BOTH
  enabled = false
  configured = false

  async init() {
    const cfg = await Config.getGlobal().catch(() => ({} as any))
    const searchKey = cfg.web?.search?.api_keys?.tinyfish
    const fetchKey = cfg.web?.fetch?.api_keys?.tinyfish
    const envKey = process.env.TINYFISH_API_KEY
    const key = searchKey || fetchKey || envKey

    if (!key) {
      this.configured = false
      return
    }

    try {
      // @ts-ignore optional dependency
      await import("@tiny-fish/sdk")
      this.enabled = true
      this.configured = true
      log.info("tinyfish initialized")
    } catch {
      log.warn("tinyfish sdk not installed. Run: bun add @tiny-fish/sdk")
      this.configured = false
    }
  }

  async testConnection(key: string) {
    let sdk: any
    try {
      // @ts-ignore optional dependency
      sdk = await import("@tiny-fish/sdk")
    } catch {
      return { success: false, error: "SDK not installed. Run: bun add @tiny-fish/sdk" }
    }
    try {
      const { TinyFish } = sdk
      const client = new TinyFish({ apiKey: key })
      await client.search.query({ query: "test" })
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }
}

class TavilyProvider implements WebProviderBackend {
  readonly id = "tavily"
  readonly name = "Tavily"
  readonly type = ProviderType.BOTH
  enabled = false
  configured = false

  async init() {
    const cfg = await Config.getGlobal().catch(() => ({} as any))
    const searchKey = cfg.web?.search?.api_keys?.tavily
    const fetchKey = cfg.web?.fetch?.api_keys?.tavily
    const envKey = process.env.TAVILY_API_KEY
    const key = searchKey || fetchKey || envKey

    if (!key) {
      this.configured = false
      return
    }

    this.enabled = true
    this.configured = true
    log.info("tavily initialized")
  }

  async testConnection(key: string) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({ query: "test", max_results: 1 }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      const msg = data.detail?.error || `${res.status} ${res.statusText}`
      return { success: false, error: msg }
    }

    return { success: true }
  }
}

class FirecrawlProvider implements WebProviderBackend {
  readonly id = "firecrawl"
  readonly name = "Firecrawl"
  readonly type = ProviderType.BOTH
  enabled = false
  configured = false

  async init() {
    const cfg = await Config.getGlobal().catch(() => ({} as any))
    const searchKey = cfg.web?.search?.api_keys?.firecrawl
    const fetchKey = cfg.web?.fetch?.api_keys?.firecrawl
    const envKey = process.env.FIRECRAWL_API_KEY
    const key = searchKey || fetchKey || envKey

    if (!key) {
      this.configured = false
      return
    }

    this.enabled = true
    this.configured = true
    log.info("firecrawl initialized")
  }

  async testConnection(key: string) {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({ url: "https://example.com", formats: ["markdown"] }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      const msg = data.error || `${res.status} ${res.statusText}`
      return { success: false, error: msg }
    }

    return { success: true }
  }
}

// --- Router (mirrors MemoryRouter) ---

export class WebRouter {
  private providers: WebProviderBackend[] = []
  private initialized = false

  async init() {
    if (this.initialized) return

    this.providers.push(new DefaultProvider("exa", "Exa", ProviderType.SEARCH))

    const tinyfish = new TinyFishProvider()
    await tinyfish.init()
    this.providers.push(tinyfish)

    const tavily = new TavilyProvider()
    await tavily.init()
    this.providers.push(tavily)

    const firecrawl = new FirecrawlProvider()
    await firecrawl.init()
    this.providers.push(firecrawl)

    this.providers.push(new DefaultProvider("direct", "Direct Fetch", ProviderType.FETCH))

    this.initialized = true
    log.info("initialized", {
      providers: this.providers.filter((p) => p.configured).map((p) => p.id),
    })
  }

  status() {
    return this.providers.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      configured: p.configured,
    }))
  }

  get(id: string): WebProviderBackend | undefined {
    return this.providers.find((p) => p.id === id)
  }

  isInitialized() {
    return this.initialized
  }

  private configured(id: string): boolean {
    const p = this.get(id)
    return p?.configured ?? false
  }

  getSearchChain(): SearchProviderID[] {
    const ordered: SearchProviderID[] = []
    for (const id of ALL_SEARCH) {
      if (this.configured(id)) ordered.push(id as SearchProviderID)
    }
    return ordered.length > 0 ? ordered : DEFAULT_SEARCH
  }

  getFetchChain(): FetchProviderID[] {
    const ordered: FetchProviderID[] = []
    for (const id of ALL_FETCH) {
      if (this.configured(id)) ordered.push(id as FetchProviderID)
    }
    return ordered.length > 0 ? ordered : DEFAULT_FETCH
  }

  getAvailableSearch(): WebProviderBackend[] {
    return this.providers.filter(
      (p) => (p.type === ProviderType.SEARCH || p.type === ProviderType.BOTH) && p.configured,
    )
  }

  getAvailableFetch(): WebProviderBackend[] {
    return this.providers.filter(
      (p) => (p.type === ProviderType.FETCH || p.type === ProviderType.BOTH || p.id === "direct") && p.configured,
    )
  }
}

// --- Router Singleton ---

let router: WebRouter | null = null

export async function getRouter(): Promise<WebRouter> {
  if (!router) {
    router = new WebRouter()
    await router.init()
  }
  return router
}

// --- Interfaces ---

export interface WebState {
  search?: { primary?: string; fallback?: string; fallback2?: string }
  fetch?: { primary?: string; fallback?: string; fallback2?: string }
}

export interface SearchOpts {
  location?: string
  language?: string
  page?: number
  numResults?: number
  timeout?: number
}

export interface FetchOpts {
  format?: "markdown" | "html" | "json" | "text"
  links?: boolean
  timeout?: number
}

export interface SearchResult {
  output: string
  title: string
  metadata: Record<string, unknown>
}

export interface FetchResult {
  output: string
  title: string
  metadata: Record<string, unknown>
  attachments?: { type: "file"; mime: string; url: string }[]
}

export namespace WebProvider {
  export async function readState(): Promise<WebState> {
    return Filesystem.readJson(STATE_FILE).catch(() => ({}))
  }

  export async function writeState(data: WebState): Promise<void> {
    await Filesystem.writeJson(STATE_FILE, data)
  }

  export async function getApiKey(id: string): Promise<string | undefined> {
    const envKey = process.env[`${id.toUpperCase()}_API_KEY`]
    if (envKey) return envKey

    const cfg = await Config.getGlobal().catch(() => ({} as any))
    if (!cfg.web) return undefined

    return cfg.web.search?.api_keys?.[id] || cfg.web.fetch?.api_keys?.[id]
  }

  export async function getSearchChain(): Promise<SearchProviderID[]> {
    const state = await readState()
    if (state.search) {
      const chain: SearchProviderID[] = []
      if (state.search.primary) chain.push(state.search.primary as SearchProviderID)
      if (state.search.fallback) chain.push(state.search.fallback as SearchProviderID)
      if (state.search.fallback2) chain.push(state.search.fallback2 as SearchProviderID)
      if (chain.length > 0) return chain
    }

    const cfg = await Config.getGlobal().catch(() => ({} as any))
    const providers = cfg.web?.search?.providers
    if (providers && providers.length > 0) return providers as SearchProviderID[]

    return DEFAULT_SEARCH
  }

  export async function getFetchChain(): Promise<FetchProviderID[]> {
    const state = await readState()
    if (state.fetch) {
      const chain: FetchProviderID[] = []
      if (state.fetch.primary) chain.push(state.fetch.primary as FetchProviderID)
      if (state.fetch.fallback) chain.push(state.fetch.fallback as FetchProviderID)
      if (state.fetch.fallback2) chain.push(state.fetch.fallback2 as FetchProviderID)
      if (chain.length > 0) return chain
    }

    const cfg = await Config.getGlobal().catch(() => ({} as any))
    const providers = cfg.web?.fetch?.providers
    if (providers && providers.length > 0) return providers as FetchProviderID[]

    return DEFAULT_FETCH
  }

  export async function getAvailableSearchProviders(): Promise<SearchProviderID[]> {
    const r = await getRouter()
    return r.getAvailableSearch().map((p) => p.id as SearchProviderID)
  }

  export async function getAvailableFetchProviders(): Promise<FetchProviderID[]> {
    const r = await getRouter()
    return r.getAvailableFetch().map((p) => p.id as FetchProviderID)
  }

  export async function testConnection(
    id: string,
    key: string,
  ): Promise<{ success: boolean; error?: string }> {
    const r = await getRouter()
    const p = r.get(id)
    if (!p) return { success: false, error: `Unknown provider: ${id}` }
    return p.testConnection(key)
  }

  export async function searchWithFallback(
    query: string,
    signal: AbortSignal,
    opts?: SearchOpts,
  ): Promise<SearchResult> {
    const chain = await getSearchChain()
    const errors: string[] = []

    for (const provider of chain) {
      try {
        const result = await searchWithProvider(provider, query, signal, opts)
        if (result) return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn("search provider failed", { provider, error: msg })
        errors.push(`${provider}: ${msg}`)
        if (err instanceof Error && err.name === "AbortError") throw err
      }
    }

    throw new Error(
      `All search providers failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    )
  }

  async function searchWithProvider(
    provider: SearchProviderID,
    query: string,
    signal: AbortSignal,
    opts?: SearchOpts,
  ): Promise<SearchResult | null> {
    switch (provider) {
      case "exa":
        return searchExa(query, signal)
      case "tinyfish":
        return searchTinyFish(query, signal, opts)
      case "tavily":
        return searchTavily(query, signal, opts)
      case "firecrawl":
        return searchFirecrawl(query, opts)
    }
  }

  async function searchExa(
    query: string,
    signal: AbortSignal,
  ): Promise<SearchResult | null> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query, type: "auto", numResults: 8, livecrawl: "fallback" },
      },
    })

    const res = await fetch("https://mcp.exa.ai/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body,
      signal,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Exa search error (${res.status}): ${text}`)
    }

    const text = await res.text()
    const lines = text.split("\n")
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const data = JSON.parse(line.slice(6))
      if (data.result?.content?.length > 0) {
        return {
          output: data.result.content[0].text,
          title: `Web search: ${query}`,
          metadata: {},
        }
      }
    }

    return {
      output: "No search results found. Please try a different query.",
      title: `Web search: ${query}`,
      metadata: {},
    }
  }

  async function searchTinyFish(
    query: string,
    signal: AbortSignal,
    opts?: SearchOpts,
  ): Promise<SearchResult | null> {
    // @ts-ignore optional dependency
    const { TinyFish } = await import("@tiny-fish/sdk")
    const key = await getApiKey("tinyfish")
    const client = new TinyFish({ apiKey: key || undefined })

    const response = await client.search.query({
      query,
      location: opts?.location,
      language: opts?.language,
    })

    const lines = response.results.map(
      (r: any) => `${r.title}\n${r.snippet}\n${r.url}`,
    )
    return {
      output: lines.join("\n\n"),
      title: `TinyFish search: ${query}`,
      metadata: { provider: "tinyfish", totalResults: response.total_results },
    }
  }

  async function searchTavily(
    query: string,
    _signal: AbortSignal,
    opts?: SearchOpts,
  ): Promise<SearchResult | null> {
    const key = await getApiKey("tavily")

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        query,
        max_results: opts?.numResults ?? 8,
        search_depth: "basic",
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Tavily search error (${res.status}): ${text}`)
    }

    const data: any = await res.json()
    const lines = data.results?.map(
      (r: any) => `## ${r.title}\n${r.content}\n${r.url}`,
    ) ?? ["No results found"]

    return {
      output: lines.join("\n\n"),
      title: `Tavily search: ${query}`,
      metadata: { provider: "tavily" },
    }
  }

  async function searchFirecrawl(
    query: string,
    _opts?: SearchOpts,
  ): Promise<SearchResult | null> {
    const key = await getApiKey("firecrawl")

    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        query,
        limit: 5,
        scrapeOptions: { formats: ["markdown"] },
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Firecrawl search error (${res.status}): ${text}`)
    }

    const data: any = await res.json()
    const results = data.data?.web || []
    const lines = results.map(
      (r: any) => `${r.title}\n${r.description || r.snippet || ""}\n${r.url}`,
    )

    return {
      output: lines.join("\n\n"),
      title: `Firecrawl search: ${query}`,
      metadata: { provider: "firecrawl" },
    }
  }

  export async function fetchWithFallback(
    urls: string[],
    signal: AbortSignal,
    opts?: FetchOpts,
  ): Promise<FetchResult> {
    const chain = await getFetchChain()
    const errors: string[] = []

    for (const provider of chain) {
      try {
        const result = await fetchWithProvider(provider, urls[0], signal, opts)
        if (result) return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn("fetch provider failed", { provider, error: msg })
        errors.push(`${provider}: ${msg}`)
        if (err instanceof Error && err.name === "AbortError") throw err
      }
    }

    throw new Error(
      `All fetch providers failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    )
  }

  async function fetchWithProvider(
    provider: FetchProviderID,
    url: string,
    signal: AbortSignal,
    opts?: FetchOpts,
  ): Promise<FetchResult | null> {
    switch (provider) {
      case "direct":
        return fetchDirect(url, signal)
      case "tinyfish":
        return fetchTinyFish(url, signal, opts)
      case "tavily":
        return fetchTavily(url, opts)
      case "firecrawl":
        return fetchFirecrawl(url, opts)
    }
  }

  async function fetchDirect(
    url: string,
    signal: AbortSignal,
  ): Promise<FetchResult | null> {
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    const res = await fetch(url, { signal, headers })
    if (!res.ok) throw new Error(`Direct fetch failed: ${res.status}`)

    const text = await res.text()
    return {
      output: text,
      title: url,
      metadata: { provider: "direct" },
    }
  }

  async function fetchTinyFish(
    url: string,
    signal: AbortSignal,
    opts?: FetchOpts,
  ): Promise<FetchResult | null> {
    // @ts-ignore optional dependency
    const { TinyFish } = await import("@tiny-fish/sdk")
    const key = await getApiKey("tinyfish")
    const client = new TinyFish({ apiKey: key || undefined })

    const result = await client.fetch.getContents({
      urls: [url],
      format: opts?.format === "json" ? "json" : opts?.format === "html" ? "html" : "markdown",
    })

    const page = result.results[0]
    const text = typeof page.text === "string" ? page.text : JSON.stringify(page.text)
    return {
      output: text,
      title: page.title || url,
      metadata: {
        provider: "tinyfish",
        description: page.description,
        language: page.language,
        format: opts?.format || "markdown",
      },
    }
  }

  async function fetchTavily(
    url: string,
    opts?: FetchOpts,
  ): Promise<FetchResult | null> {
    const key = await getApiKey("tavily")

    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        urls: [url],
        format: opts?.format === "markdown" ? "markdown" : "text",
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Tavily extract error (${res.status}): ${text}`)
    }

    const data: any = await res.json()
    const raw = data.results?.[0] || data
    return {
      output: raw.raw_content || JSON.stringify(raw),
      title: raw.title || raw.url || url,
      metadata: {
        provider: "tavily",
        format: opts?.format || "markdown",
      },
    }
  }

  async function fetchFirecrawl(
    url: string,
    opts?: FetchOpts,
  ): Promise<FetchResult | null> {
    const key = await getApiKey("firecrawl")

    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        url,
        formats: [
          opts?.format === "html" ? "html"
            : opts?.format === "json" ? "json"
            : "markdown",
        ],
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Firecrawl scrape error (${res.status}): ${text}`)
    }

    const data: any = await res.json()
    const result = data.data || data
    return {
      output: result.markdown || JSON.stringify(result),
      title: result.metadata?.title || url,
      metadata: {
        provider: "firecrawl",
        description: result.metadata?.description,
        format: opts?.format || "markdown",
      },
    }
  }
}
