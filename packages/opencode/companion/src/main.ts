import { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, screen } from "electron"
import { inference, initializeLogger } from "@livekit/agents"
import { initMain } from "electron-audio-loopback"

// Initialize LiveKit logger before any TTS/STT usage
initializeLogger({ pretty: false, level: "error" })
initMain()
import path from "path"
import fs from "fs"
import os from "os"
import { spawn } from "child_process"
import { streamText } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createXai } from "@ai-sdk/xai"
import { createGroq } from "@ai-sdk/groq"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { createAzure } from "@ai-sdk/azure"

const ROOT = path.dirname(process.argv[1] || __dirname)
const cfgDir = path.join(os.homedir(), ".config", "handofai")
const stateDir = path.join(os.homedir(), ".local", "state", "handofai")
const statePath = path.join(stateDir, "model.json")
const dataDir = path.join(os.homedir(), ".local", "share", "handofai")
const logPath = path.join(stateDir, "companion.log")
const guideStatePath = path.join(stateDir, "companion-guide.json")

function log(msg: string) {
  const line = `${Date.now()} companion ${msg}\n`
  try { fs.appendFileSync(logPath, line) } catch {
    try { fs.appendFileSync(path.join(os.tmpdir(), "companion-fallback.log"), line) } catch {}
  }
  console.log(msg)
}

function logErr(msg: string, e?: any) {
  const d = e ? ` ${e?.message || e}` : ""
  log(`ERROR ${msg}${d}`)
  if (e?.stack) try { fs.appendFileSync(logPath, `  ${e.stack}\n`); } catch {}
}

function stripJSONC(text: string): string {
  let out = ""
  let inStr = false
  let strCh = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inStr) {
      if (ch === strCh && text[i - 1] !== "\\") { out += ch; inStr = false }
      else if (ch === "\\" && i + 1 < text.length) { out += ch + text[i + 1]; i++ }
      else out += ch
    } else {
      if (ch === '"' || ch === "'") { out += ch; inStr = true; strCh = ch }
      else if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++ }
      else if (ch === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++ }
      else if (ch === ",") {
        let j = i + 1
        while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) j++
        if (j < text.length && (text[j] === "}" || text[j] === "]")) continue
        out += ch
      }
      else out += ch
    }
    i++
  }
  return out
}

function readCfg(): any {
  const files = ["handofai.jsonc", "handofai.json", "config.json"]
  for (const f of files) {
    try {
      const p = path.join(cfgDir, f)
      const raw = fs.readFileSync(p, "utf-8")
      try { return JSON.parse(raw) } catch {}
      return JSON.parse(stripJSONC(raw))
    } catch {}
  }
  return {}
}

function findCfgPath(): string | null {
  const files = ["handofai.jsonc", "handofai.json", "config.json"]
  for (const f of files) {
    const p = path.join(cfgDir, f)
    try { if (fs.statSync(p).isFile()) return p } catch {}
  }
  return null
}

function readModelState(): any {
  try { return JSON.parse(fs.readFileSync(statePath, "utf-8")) } catch { return {} }
}

// --- Models.dev (copied from TUI's ModelsDev namespace) ---

function readModelsDev(): Record<string, any> {
  const paths = [
    path.join(os.homedir(), ".cache", "handofai", "models.json"),
    path.join(os.homedir(), ".cache", "opencode", "models.json"),
  ]
  for (const p of paths) {
    try { return JSON.parse(fs.readFileSync(p, "utf-8")) } catch {}
  }
  try {
    const json = fs.readFileSync(path.join(ROOT, "models-snapshot.js"), "utf-8")
    const m = json.match(/export\s+const\s+snapshot\s*=\s*({[\s\S]*})/)
    if (m) return JSON.parse(m[1])
  } catch {}
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "..", "src", "provider", "models-snapshot.js"), "utf-8"))
  } catch {}
  return {}
}

// --- Provider state (copied from TUI's Provider.state()) ---

const BUNDLED: Record<string, (opts: any) => any> = {
  "@ai-sdk/openai": (o) => createOpenAI(o),
  "@ai-sdk/anthropic": (o) => createAnthropic(o),
  "@ai-sdk/google": (o) => createGoogleGenerativeAI(o),
  "@ai-sdk/mistral": (o) => createMistral(o),
  "@ai-sdk/xai": (o) => createXai(o),
  "@ai-sdk/groq": (o) => createGroq(o),
  "@openrouter/ai-sdk-provider": (o) => createOpenRouter(o),
  "@ai-sdk/openai-compatible": (o) => createOpenAICompatible(o),
  "@ai-sdk/deepinfra": (o) => createDeepInfra(o),
  "@ai-sdk/cerebras": (o) => createCerebras(o),
  "@ai-sdk/cohere": (o) => createCohere(o),
  "@ai-sdk/togetherai": (o) => createTogetherAI(o),
  "@ai-sdk/perplexity": (o) => createPerplexity(o),
  "@ai-sdk/vercel": (o) => createVercel(o),
  "@ai-sdk/azure": (o) => createAzure(o),
}

function readAuth(): Record<string, string> {
  const authFile = path.join(dataDir, "auth.json")
  try {
    const data = JSON.parse(fs.readFileSync(authFile, "utf-8"))
    const out: Record<string, string> = {}
    for (const [id, entry] of Object.entries(data)) {
      if ((entry as any)?.type === "api" && (entry as any)?.key) out[id] = (entry as any).key
    }
    return out
  } catch { return {} }
}

// TUI pattern: fromModelsDevModel → internal Model format with api.id, api.url, api.npm
function fromModel(pid: string, mid: string, raw: any, prov: any): any {
  return {
    id: mid,
    providerID: pid,
    api: {
      id: raw?.id ?? mid,
      url: raw?.provider?.api ?? prov?.api,
      npm: raw?.provider?.npm ?? prov?.npm ?? "@ai-sdk/openai-compatible",
    },
    capabilities: {
      input: {
        image: raw?.modalities?.input?.includes("image") ?? false,
        audio: raw?.modalities?.input?.includes("audio") ?? false,
        text: raw?.modalities?.input?.includes("text") ?? true,
      },
      output: {
        audio: raw?.modalities?.output?.includes("audio") ?? false,
        text: raw?.modalities?.output?.includes("text") ?? true,
      },
    },
    cost: {
      input: raw?.cost?.input ?? 0,
      output: raw?.cost?.output ?? 0,
    },
    limit: {
      context: raw?.limit?.context ?? 0,
      input: raw?.limit?.input ?? 0,
      output: raw?.limit?.output ?? 0,
    },
    options: raw?.options ?? {},
    headers: raw?.headers ?? {},
  }
}

let _state: any = null

// TUI pattern: state() — builds full provider state with env → auth → custom loaders → config
async function buildState() {
  if (_state) return _state
  const modelsDev = readModelsDev()
  const cfg = readCfg()
  const auth = readAuth()
  const env = process.env

  const providers: Record<string, any> = {}

  // Load from models.dev
  for (const [pid, prov] of Object.entries(modelsDev) as any) {
    const p: any = {
      id: pid,
      name: (prov as any).name ?? pid,
      env: (prov as any).env ?? [],
      options: {},
      key: undefined as string | undefined,
      models: {} as Record<string, any>,
    }
    for (const [mid, raw] of Object.entries((prov as any).models ?? {})) {
      p.models[mid] = fromModel(pid, mid, raw as any, prov as any)
    }
    providers[pid] = p
  }

  // Load env vars (TUI: lines 1066-1077)
  for (const [pid, prov] of Object.entries(providers)) {
    for (const name of prov.env) {
      if (env[name]) { prov.key = env[name]; break }
    }
  }

  // Load auth.json (TUI: lines 1079-1089)
  for (const [pid, key] of Object.entries(auth)) {
    if (providers[pid]) providers[pid].key = key
  }

  // Custom loaders (TUI: lines 1108-1125)
  // opencode: if no key, strip paid models, pass apiKey: "public"
  const opencode = providers["opencode"]
  if (opencode && !opencode.key) {
    for (const [mid, m] of Object.entries(opencode.models) as any) {
      if ((m as any).cost?.input > 0 || (m as any).cost?.output > 0) delete opencode.models[mid]
    }
    opencode.options.apiKey = "public"
  }

  // Load config providers (TUI: lines 1127-1135)
  for (const [pid, pc] of Object.entries(cfg.provider ?? {}) as any) {
    if (!providers[pid]) {
      providers[pid] = { id: pid, name: pid, env: [], options: {}, models: {} }
    }
    const p = providers[pid]
    if ((pc as any).options) Object.assign(p.options, (pc as any).options)
    if ((pc as any).env) p.env = (pc as any).env
    if ((pc as any).models) {
      for (const [mid, mc] of Object.entries((pc as any).models) as any) {
        if (!p.models[mid]) {
          p.models[mid] = fromModel(pid, mid, mc as any, p)
        }
      }
    }
  }

  _state = { providers, modelsDev }
  return _state
}

// TUI pattern: Provider.getModel()
async function getModel(pid: string, mid: string) {
  const s = await buildState()
  const prov = s.providers[pid]
  if (!prov) return null
  return prov.models[mid] ?? null
}

// TUI pattern: Provider.getSDK() + Provider.getLanguage()
async function getSDK(model: any) {
  const s = await buildState()
  const prov = s.providers[model.providerID]
  if (!prov) return null

  const opts: any = { name: model.providerID, ...prov.options }

  // BaseURL: model.api.url (TUI: lines 1224-1246)
  if (model.api.url) opts.baseURL = model.api.url

  // apiKey from provider.key (TUI: line 1249)
  if (opts.apiKey === undefined && prov.key) opts.apiKey = prov.key

  // Headers (TUI: lines 1250-1254)
  if (model.headers) opts.headers = { ...opts.headers, ...model.headers }

  // includeUsage for OpenAI-compatible (TUI: lines 1220-1222)
  if (model.api.npm.includes("@ai-sdk/openai-compatible") && opts.includeUsage !== false) {
    opts.includeUsage = true
  }

  const factory = BUNDLED[model.api.npm]
  if (!factory) return null

  const sdk = factory(opts)
  return sdk.languageModel(model.api.id)
}

// TUI pattern: Provider.getLanguage() — cached
const langCache = new Map<string, any>()

async function getLanguage(model: any) {
  const key = `${model.providerID}/${model.id}`
  const cached = langCache.get(key)
  if (cached) return cached

  const lang = await getSDK(model)
  if (lang) langCache.set(key, lang)
  return lang
}

function modelMaxTokens(model: any): number {
  return Math.min(model?.limit?.output ?? 32000, 32000) || 32000
}

function modelTemp(mid: string): number | undefined {
  const id = mid.toLowerCase()
  if (id.includes("qwen")) return 0.55
  if (id.includes("gemini")) return 1
  return undefined
}

// Resolve companion model from state (TUI pattern: reads model.json)
async function resolveCompanionModel() {
  const s = await buildState()
  const md = readModelState()
  const entry = md.model?.companion || md.recent?.[0]
  if (!entry?.providerID || !entry?.modelID) return null
  const model = await getModel(entry.providerID, entry.modelID)
  if (!model) return null
  const lang = await getLanguage(model)
  if (!lang) return null
  return { model, lang, pid: entry.providerID, mid: entry.modelID }
}

// Resolve vision model from state (TUI pattern: vision.ts lines 136-139)
async function resolveVisionModel() {
  const md = readModelState()
  const entry = md.visionModel
  if (!entry?.providerID || !entry?.modelID) return null
  const model = await getModel(entry.providerID, entry.modelID)
  if (!model) return null
  if (!model.capabilities.input.image) {
    log(`Vision model ${entry.providerID}/${entry.modelID} lacks image capability, falling back`)
    return null
  }
  const lang = await getLanguage(model)
  if (!lang) return null
  return { model, lang, pid: entry.providerID, mid: entry.modelID }
}

// --- Electron window management (unchanged, working) ---

let bar: BrowserWindow | null = null
let panel: BrowserWindow | null = null
let conversationHistory: Array<{role: 'user' | 'assistant', text: string}> = []
let appState: any = { mic: true, dictationActive: false }
let visible = true
let chatWindowVisible = true
let isInteractive = true
let barMicActive = false
let screenShareInterval: ReturnType<typeof setInterval> | null = null
let guideInterval: ReturnType<typeof setInterval> | null = null
let micProcess: any = null
let micTempDir: string | null = null
let guideRunning = false
let guideErrors = 0
let ttsEnabled = false
let ttsCtl: AbortController | null = null
let ttsInst: any = null
let guideConfig: any = {
  adviceDuration: 8000,
  screenshotInterval: 20000,
  captureSystemAudio: true,
  systemAudioDevice: undefined as string | undefined,
  silenceTimeout: 2000
}

// Request queue — serializes screenshot + chat requests so streams never overlap
let reqQueue: Array<{type: string, fn: () => Promise<void>}> = []
let queueBusy = false

async function enqueue(type: string, fn: () => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    reqQueue.push({ type, fn: async () => { try { await fn(); resolve() } catch(e) { reject(e) } } })
    if (!queueBusy) processQueue()
  })
}

async function processQueue() {
  if (queueBusy || reqQueue.length === 0) return
  queueBusy = true
  const { type, fn } = reqQueue.shift()!
  try { await fn() } catch(e) { logErr(`Queue ${type}`, e) }
  queueBusy = false
  processQueue()
}

app.setName("Terminal")
process.title = "Terminal"
app.setAppUserModelId("")

process.on("uncaughtException", (e) => {
  const msg = `FATAL uncaughtException: ${e?.stack || e}\n`
  try { fs.appendFileSync(logPath, msg) } catch {}
  console.error(msg)
})
process.on("unhandledRejection", (e: any) => {
  const msg = `Unhandled rejection: ${e?.stack || e}\n`
  try { fs.appendFileSync(logPath, msg) } catch {}
  console.error(msg)
})

const pidPath = path.join(stateDir, "companion.pid")
let oldPid = 0
try {
  if (fs.existsSync(pidPath)) {
    oldPid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10)
    if (oldPid) process.kill(oldPid)
  }
} catch {}

try { fs.mkdirSync(stateDir, { recursive: true }) } catch (e: any) {
  console.error(`Cannot create state dir ${stateDir}: ${e.message}`)
  process.exit(1)
}
try { fs.writeFileSync(logPath, "") } catch (e: any) {
  console.error(`Cannot write log ${logPath}: ${e.message}`)
  process.exit(1)
}

const sessionStart = new Date().toISOString()
log(`=== Session ${sessionStart} ===`)
if (oldPid) log(`Killed old PID: ${oldPid}`)
log(`PID: ${process.pid}`)
fs.writeFileSync(pidPath, String(process.pid))
process.on("exit", () => { try { fs.unlinkSync(pidPath) } catch {} })
log(`State dir: ${stateDir}`)

let lastAssistantText = ""
let webSearchEnabled = true

async function doChat(text: string) {
  const resolved = await resolveCompanionModel()
  if (!resolved) {
    logErr("No model configured")
    panel?.webContents.send("stream_chunk", { text: "Error: No model configured." })
    panel?.webContents.send("stream_end", {})
    return
  }
  
  // Add user message to history
  conversationHistory.push({ role: 'user', text })
  
  // Keep only last 20 exchanges (40 messages total)
  if (conversationHistory.length > 40) {
    conversationHistory = conversationHistory.slice(-40)
  }
  
  // Build full context for LLM
  const contextPrompt = buildContextPrompt()
  
  panel?.webContents.send("user_msg", { text, id: Date.now().toString() })
  
  try {
    const result = streamText({ 
      model: resolved.lang, 
      messages: [{ 
        role: "user", 
        content: contextPrompt + "\n\nUser: " + text 
      }],
      temperature: modelTemp(resolved.mid),
      maxOutputTokens: modelMaxTokens(resolved.model),
      abortSignal: AbortSignal.timeout(60000),
    })
    let full = ""
    for await (const chunk of result.textStream) {
      full += chunk
      lastAssistantText = full
      panel?.webContents.send("stream_chunk", { text: full })
    }
    panel?.webContents.send("stream_end", {})
    log(`Chat response: ${full.length} chars`)
    
    // Add AI response to history
    conversationHistory.push({ role: 'assistant', text: full })
  } catch (e) {
    logErr("Chat failed", e)
    panel?.webContents.send("stream_chunk", { text: `Error: ${e?.message || e}` })
    panel?.webContents.send("stream_end", {})
  }
}

// Process user input (from mic or text) with conversation context
async function processUserInput(text: string, fromSpeech: boolean = false) {
  if (!text.trim()) return
  await enqueue('chat', async () => {
    conversationHistory.push({ role: 'user', text })
    panel?.webContents.send("user_msg", { text })
    if (conversationHistory.length > 40) conversationHistory = conversationHistory.slice(-40)
    const contextPrompt = buildContextPrompt()
    
    try {
      let resolved = await resolveCompanionModel()
      if (!resolved) {
        logErr("No model configured")
        panel?.webContents.send("stream_chunk", { text: "Error: No model configured." })
        panel?.webContents.send("stream_end", {})
        return
      }
      
      let modelId = resolved.lang
      let msgContent: any
      if (webSearchEnabled) {
        const sr = await performWebSearch(text)
        if (sr) {
          msgContent = `${contextPrompt}\n\nWeb search results:\n${sr}\n\nUse the search results to answer. Include source URLs as markdown links in your response.\n\nUser: ${text}`
        }
      }
      if (!msgContent) msgContent = contextPrompt + "\n\nUser: " + text
      
      const result = streamText({ 
        model: modelId,
        messages: [{ role: "user", content: msgContent }],
        temperature: modelTemp(resolved.mid),
        maxOutputTokens: modelMaxTokens(resolved.model),
        abortSignal: AbortSignal.timeout(60000),
      })
      let full = ""
      for await (const chunk of result.textStream) {
        full += chunk
        lastAssistantText = full
        panel?.webContents.send("stream_chunk", { text: full })
      }
      panel?.webContents.send("stream_end", {})
      
      conversationHistory.push({ role: 'assistant', text: full })
      
      if (ttsEnabled && full) doTTS(full)
    } catch (e) {
      logErr("Chat processing failed", e)
      panel?.webContents.send("stream_chunk", { text: "Error processing request" })
      panel?.webContents.send("stream_end", {})
    }
  })
}

function buildContextPrompt(): string {
  if (conversationHistory.length === 0) return ""
  
  let prompt = "Previous conversation context:\n"
  conversationHistory.forEach((msg, index) => {
    const role = msg.role === 'user' ? 'User' : 'Assistant'
    prompt += `${index + 1}. ${role}: ${msg.text}\n`
  })
  prompt += "\nNow respond to the latest user message above:\n"
   return prompt
}

function sendResult(text: string) {
  panel?.webContents.send("stream_chunk", { text })
  panel?.webContents.send("stream_end", {})
}

async function searchWithProvider(p: string, q: string): Promise<string | null> {
  try {
    if (p === "exa") {
      const body = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "web_search_exa", arguments: { query: q, type: "auto", numResults: 5, livecrawl: "fallback" } },
      })
      const res = await fetch("https://mcp.exa.ai/mcp", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        body, signal: AbortSignal.timeout(25000),
      })
      if (!res.ok) return null
      const text = await res.text()
      for (const l of text.split("\n")) {
        if (!l.startsWith("data: ")) continue
        const d = JSON.parse(l.slice(6))
        if (d.result?.content?.length > 0) return d.result.content[0].text
      }
      return null
    }
    const cfg = readCfg()
    const keys = cfg?.web?.search?.api_keys || {}
    if (p === "tavily") {
      const k = process.env.TAVILY_API_KEY || keys.tavily
      if (!k) return null
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${k}` },
        body: JSON.stringify({ query: q, max_results: 5, search_depth: "basic" }),
        signal: AbortSignal.timeout(25000),
      })
      if (!res.ok) return null
      const d: any = await res.json()
      if (!d.results?.length) return null
      return d.results.map((r: any) => `## ${r.title}\n${r.content}\n${r.url}`).join("\n\n")
    }
    if (p === "firecrawl") {
      const k = process.env.FIRECRAWL_API_KEY || keys.firecrawl
      if (!k) return null
      const res = await fetch("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${k}` },
        body: JSON.stringify({ query: q, limit: 5, scrapeOptions: { formats: ["markdown"] } }),
        signal: AbortSignal.timeout(25000),
      })
      if (!res.ok) return null
      const d: any = await res.json()
      const wb = d.data?.web || []
      if (!wb.length) return null
      return wb.map((r: any) => `${r.title}\n${r.description || r.snippet || ""}\n${r.url}`).join("\n\n")
    }
    if (p === "tinyfish") {
      let TinyFish: any
      try { TinyFish = (await import("@tiny-fish/sdk")).TinyFish } catch { return null }
      const k = process.env.TINYFISH_API_KEY || keys.tinyfish
      const cl = new TinyFish({ apiKey: k || undefined })
      const r = await cl.search.query({ query: q })
      if (!r.results?.length) return null
      return r.results.map((r: any) => `${r.title}\n${r.snippet}\n${r.url}`).join("\n\n")
    }
    return null
  } catch { return null }
}

async function performWebSearch(q: string): Promise<string> {
  const wpPath = path.join(stateDir, "web-provider.json")
  let chain: string[] = []
  try {
    const s = JSON.parse(fs.readFileSync(wpPath, "utf-8"))
    const sh = s.search
    if (sh?.primary) chain.push(sh.primary)
    if (sh?.fallback) chain.push(sh.fallback)
    if (sh?.fallback2) chain.push(sh.fallback2)
  } catch {}
  if (chain.length === 0) {
    const cfg = readCfg()
    chain = cfg?.web?.search?.providers || ["exa"]
  }
  for (const p of chain) {
    const r = await searchWithProvider(p, q)
    if (r) return r
  }
  return ""
}

async function analyzeScreenshot(data: string, question: string): Promise<boolean> {
  let vision = await resolveVisionModel()
  if (!vision) {
    log("Vision model unavailable, falling back to chat model")
    const chat = await resolveCompanionModel()
    if (!chat) {
      logErr("No model available for screenshot analysis")
      sendResult("Error: No model available.")
      if (guideRunning) guideErrors++
      return false
    }
    vision = chat
  }

  const tryVision = async () => {
    const result = streamText({
      model: vision!.lang,
      messages: [{ role: "user", content: [{ type: "text", text: question }, { type: "image", image: `data:image/png;base64,${data}` }] }],
      temperature: modelTemp(vision!.mid),
      maxOutputTokens: modelMaxTokens(vision!.model),
      abortSignal: AbortSignal.timeout(60000),
    })
    let full = ""
    for await (const chunk of result.textStream) full += chunk
    return full
  }

  try {
    const full = await tryVision()
    if (!full || full.trim().length === 0) {
      log("Vision result empty")
      sendResult(full || "")
      return true
    }
    lastAssistantText = full
    if (webSearchEnabled && full?.trim()) {
      try {
        const sr = await performWebSearch(full)
        if (sr) {
          const chat = await resolveCompanionModel()
          if (chat) {
            const pr = `Vision analysis: ${full}\n\nWeb search results:\n${sr}\n\nUsing the analysis and search results, respond. Include source URLs as markdown links.\n\n${question}`
            const r = streamText({ model: chat.lang, messages: [{ role: "user", content: pr }], temperature: modelTemp(chat.mid), maxOutputTokens: modelMaxTokens(chat.model), abortSignal: AbortSignal.timeout(60000) })
            let f2 = ""
            for await (const c of r.textStream) f2 += c
            if (f2?.trim()) {
              lastAssistantText = f2
              sendResult(f2)
              if (ttsEnabled && f2) doTTS(f2)
              return true
            }
          }
        }
      } catch {}
    }
    sendResult(full)
    if (ttsEnabled && full) doTTS(full)
    return true
  } catch (e) {
    logErr("Vision analysis failed, falling back to chat model", e)
    try {
      const chat = await resolveCompanionModel()
      if (chat && chat.pid !== vision.pid) {
        const result = streamText({ model: chat.lang, messages: [{ role: "user", content: question }], temperature: modelTemp(chat.mid), maxOutputTokens: modelMaxTokens(chat.model), abortSignal: AbortSignal.timeout(60000) })
        let full = ""
        for await (const chunk of result.textStream) full += chunk
        lastAssistantText = full
        sendResult(full)
        if (ttsEnabled && full) doTTS(full)
        return true
      }
    } catch (e2) { logErr("Chat fallback also failed", e2) }
    sendResult(`Error: ${e?.message || e}`)
    if (guideRunning) guideErrors++
    return false
  }
}

// --- TTS/STT — renderer-based audio I/O (proper Electron pattern) ---

// Renderer-based playback: send WAV base64 to panel window, play via HTML5 Audio
function sendTTSAudio(b64: string) {
  if (!panel || panel.isDestroyed()) { logErr("TTS: panel not available"); return }
  try {
    panel.webContents.send("tts_audio", { data: b64 })
    log("TTS: sent to renderer")
  } catch (e) { logErr("TTS: send failed", e) }
}

// TUI pattern: voice.ts synthesizeWithYarnGPT
async function synthYarnGPT(text: string, voice: string, vc: any, signal?: AbortSignal) {
  const baseUrl = vc.yarngpt?.base_url || "https://yarngpt.ai/api/v1"
  const key = vc.provider_keys?.yarngpt
  if (!key) { logErr("No YarnGPT key"); return }
  const res = await fetch(`${baseUrl}/tts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, response_format: "wav" }),
    signal,
  })
  if (!res.ok) { logErr(`YarnGPT ${res.status}`); return }
  sendTTSAudio(Buffer.from(await res.arrayBuffer()).toString("base64"))
  log("TTS: YarnGPT done")
}

// TUI pattern: voice.ts synthesizeWithOpenAICompatible
async function synthOpenAI(text: string, model: string, voice: string, apiKey: string, apiUrl: string | undefined, signal?: AbortSignal) {
  const baseUrl = (apiUrl || "https://api.openai.com/v1").replace(/\/+$/, "")
  const res = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/octet-stream" },
    body: JSON.stringify({ input: text, model, voice, response_format: "wav" }),
    signal,
  })
  if (!res.ok) { logErr(`TTS ${res.status}`); return }
  sendTTSAudio(Buffer.from(await res.arrayBuffer()).toString("base64"))
  log("TTS: OpenAI-compatible done")
}

// TUI pattern: voice.ts synthesizeWithLiveKit
async function synthLiveKit(text: string, model: string, voice: string, lk: any, signal?: AbortSignal) {
  const { inference } = await import("@livekit/agents")
  const tts = new inference.TTS({
    model: model as any, voice,
    apiKey: lk.api_key,
    apiSecret: lk.api_secret,
  })
  ttsInst = tts
  try {
    const stream = tts.stream()
    stream.pushText(text)
    stream.flush()
    stream.endInput()
    const frames: any[] = []
    for await (const event of stream) {
      if (signal?.aborted) break
      const ev = event as any
      if (ev.frame) frames.push(ev.frame)
    }
    if (signal?.aborted || frames.length === 0) { ttsInst = null; return }
    const first = frames[0] as any
    const sr = first.sampleRate, ch = first.channels
    const total = frames.reduce((s: number, f: any) => s + f.samplesPerChannel, 0)
    const combined = new Int16Array(total * ch)
    let off = 0
    for (const frame of frames) {
      const f = frame as any
      const d = f.data as Int16Array | Float32Array
      if (d instanceof Float32Array) {
        for (let i = 0; i < d.length; i++)
          combined[off + i] = Math.max(-32768, Math.min(32767, Math.round(d[i] * 32768)))
      } else {
        combined.set(d, off)
      }
      off += f.data?.length || 0
    }
    sendTTSAudio(buildWav(combined, sr, ch).toString("base64"))
    log("TTS: LiveKit done")
  } finally {
    ttsInst = null
    await tts.close()
  }
}

function buildWav(data: Int16Array, sr: number, ch: number): Buffer {
  const bps = 16, br = sr * ch * (bps / 8), ba = ch * (bps / 8)
  const ds = data.byteLength, hs = 44, fs = hs + ds
  const buf = Buffer.alloc(fs)
  let o = 0
  buf.write("RIFF", o); o += 4
  buf.writeUInt32LE(fs - 8, o); o += 4
  buf.write("WAVE", o); o += 4
  buf.write("fmt ", o); o += 4
  buf.writeUInt32LE(16, o); o += 4
  buf.writeUInt16LE(1, o); o += 2
  buf.writeUInt16LE(ch, o); o += 2
  buf.writeUInt32LE(sr, o); o += 4
  buf.writeUInt32LE(br, o); o += 4
  buf.writeUInt16LE(ba, o); o += 2
  buf.writeUInt16LE(bps, o); o += 2
  buf.write("data", o); o += 4
  buf.writeUInt32LE(ds, o); o += 4
  data.forEach((s) => { buf.writeInt16LE(s, o); o += 2 })
  return buf
}

async function doTTS(text: string) {
  if (ttsCtl) { ttsCtl.abort(); ttsCtl = null }
  if (ttsInst) { try { await ttsInst.close() } catch {}; ttsInst = null }
  ttsCtl = new AbortController()
  const s = ttsCtl.signal
  try {
    const cfg = readCfg()
    const vc = cfg?.voice
    if (!vc?.tts?.model || !text) return
    const model = vc.tts.model
    const voice = vc.tts.voice || "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"

    if (model === "yarngpt/tts") { await synthYarnGPT(text, voice, vc, s); return }

    const [providerID] = model.includes("/") ? model.split("/") : ["", model]
    const modelsDev = readModelsDev()
    const mdModel = modelsDev[providerID]?.models?.[model]
    const hasAudio = mdModel?.modalities?.output?.includes("audio")

    if (hasAudio) {
      const auth = readAuth()
      const apiKey = vc.provider_keys?.[providerID] || auth[providerID]
      if (!apiKey) { logErr(`No TTS key for ${providerID}`); return }
      const apiUrl = mdModel.provider?.api ?? modelsDev[providerID]?.api
      await synthOpenAI(text, model, voice, apiKey, apiUrl, s)
      return
    }

    if (vc.livekit?.url && vc.livekit?.api_key && vc.livekit?.api_secret) {
      await synthLiveKit(text, model, voice, vc.livekit, s)
      return
    }

    log("TTS: no compatible backend")
  } catch (e) {
    if ((e as any)?.name === "AbortError") return
    logErr("TTS failed", e)
  }
}

// TUI pattern: stt-engine.ts transcribeAudio
async function doSTT(model: string, filePath: string, vc: any): Promise<string> {
  const [providerID] = model.includes("/") ? model.split("/") : ["", model]
  const modelsDev = readModelsDev()
  const mdModel = modelsDev[providerID]?.models?.[model]
  const hasAudio = mdModel?.modalities?.input?.includes("audio")

  if (hasAudio) {
    const auth = readAuth()
    const apiKey = vc.provider_keys?.[providerID] || auth[providerID]
    if (!apiKey) throw new Error(`No STT key for ${providerID}`)
    const apiUrl = mdModel.provider?.api ?? modelsDev[providerID]?.api
    const baseUrl = (apiUrl || "https://api.openai.com/v1").replace(/\/+$/, "")
    const audio = fs.readFileSync(filePath)
    const blob = new Blob([audio], { type: "audio/wav" })
    const form = new FormData()
    form.append("file", blob, "audio.wav")
    form.append("model", model)
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
    if (!res.ok) throw new Error(`STT ${res.status}`)
    const j = await res.json()
    return j?.text || ""
  }

  if (!vc.livekit?.url || !vc.livekit?.api_key || !vc.livekit?.api_secret) {
    throw new Error("LiveKit not configured for STT")
  }
  const { inference } = await import("@livekit/agents")
  const { AudioFrame } = await import("@livekit/rtc-node")
  const stt = new inference.STT({
    model: model as any,
    language: "en" as any,
    apiKey: vc.livekit.api_key,
    apiSecret: vc.livekit.api_secret,
    encoding: "pcm_s16le",
    sampleRate: 16000,
  })
  const stream = stt.stream()
  const ffmpeg = spawn("ffmpeg", [
    "-i", filePath, "-f", "s16le", "-ar", "16000", "-ac", "1", "-", "-loglevel", "error",
  ], { stdio: ["ignore", "pipe", "pipe"] })
  const chunks: Buffer[] = []
  for await (const c of ffmpeg.stdout!) chunks.push(c)
  const exit = await new Promise<number>((r) => ffmpeg.on("exit", r))
  if (exit !== 0) { stream.close(); await stt.close(); throw new Error(`ffmpeg exit ${exit}`) }
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const pcm = Buffer.concat(chunks)
  const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2)
  if (int16.length === 0) { stream.close(); await stt.close(); throw new Error("No audio data") }
  for (let i = 0; i < int16.length; i += 800) {
    const end = Math.min(i + 800, int16.length)
    stream.pushFrame(new AudioFrame(int16.slice(i, end), 16000, 1, end - i))
  }
  stream.flush()
  stream.endInput()
  let text = ""
  for await (const ev of stream) {
    if (ev.type === 2 && ev.alternatives?.[0]?.text) text += (text ? " " : "") + ev.alternatives[0].text
  }
  stream.close()
  await stt.close()
  return text
}

// --- Screenshot ---

let screenshotCount = 0

async function captureScreenshot() {
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1920, height: 1080 } })
    if (sources.length === 0) return
    const img = sources[0].thumbnail.toPNG()
    const data = img.toString("base64")
    const prompt = guideRunning
      ? "Look at what's on the user's screen. What task are they trying to do? Give one concise sentence to help them, max 30 words."
      : "Analyze this screenshot. What do you see?"
    const prefix = guideRunning ? "[Guide Mode] " : ""
    await enqueue('screenshot', async () => {
      screenshotCount++
      panel?.webContents.send("user_msg", { text: `${prefix}Screenshot ${screenshotCount}` })
      const ok = await analyzeScreenshot(data, prompt)
      if (ok) {
        guideErrors = 0
        conversationHistory.push({ role: 'user', text: `${prefix}Screenshot ${screenshotCount}` })
        if (lastAssistantText) conversationHistory.push({ role: 'assistant', text: lastAssistantText })
      }
    })
  } catch (e) { logErr("Screenshot failed", e) }
  if (guideRunning && guideErrors >= 3) {
    log("Guide mode: stopping after 3 consecutive errors")
    enqueue('chat', async () => {
      panel?.webContents.send("user_msg", { text: "[Guide Mode]" })
      panel?.webContents.send("stream_chunk", { text: "Guide mode stopped: too many errors." })
      panel?.webContents.send("stream_end", {})
    })
    stopGuideMode()
  } else if (guideRunning && guideErrors > 0) {
    log(`Guide mode error #${guideErrors}`)
  }
}

// --- Mic / STT (streaming, matching TUI pattern: stdout pipe → LiveKit STT) ---

let micSTTActive = false
let micSTTProc: any = null
let micSTTStream: any = null
let micSTTInstance: any = null
let micCommitted = ""
let micSTTFlushSamples = 0

// Renderer-path: separate STT streams for system audio and mic
let sysOn = false, sysS: any = null, sysI: any = null, sysT = "", sysF = 0
let micOn = false, micS: any = null, micI: any = null, micT = "", micF = 0

async function startContinuousMic(fromRenderer = false) {
  if (micSTTActive) return
  micSTTActive = true
  micCommitted = ""

  const cfg = readCfg()
  const vc = cfg?.voice || {}
  const model = vc?.stt?.model || "deepgram/nova-3"

  if (!vc?.livekit?.url || !vc?.livekit?.api_key || !vc?.livekit?.api_secret) {
    logErr("LiveKit not configured for streaming STT")
    micSTTActive = false
    return
  }

  const { AudioFrame } = await import("@livekit/rtc-node")
  const stt = new inference.STT({
    model: model as any, language: "en" as any,
    apiKey: vc.livekit.api_key, apiSecret: vc.livekit.api_secret,
    encoding: "pcm_s16le", sampleRate: 16000,
  })
  const stream = stt.stream()
  micSTTInstance = stt
  micSTTStream = stream

  if (!fromRenderer) {
    const captureSystemAudio = cfg?.voice?.captureSystemAudio ?? true
    let ffmpegArgs: string[]

    if (process.platform === 'win32') {
      const sysDev = cfg?.voice?.systemAudioDevice
      const micDev = cfg?.voice?.ffmpeg_device || 'Microphone'
      if (captureSystemAudio && sysDev && sysDev !== micDev) {
        ffmpegArgs = [
          '-f', 'dshow', '-i', `audio=${sysDev}`,
          '-f', 'dshow', '-i', `audio=${micDev}`,
          '-filter_complex', '[0:a][1:a]amerge=inputs=2[aout]',
          '-map', '[aout]', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'
        ]
      } else {
        if (captureSystemAudio) log("System audio device same as mic or unconfigured, using mic only")
        ffmpegArgs = [
          '-f', 'dshow', '-i', `audio=${micDev}`,
          '-f', 's16le', '-ar', '16000', '-ac', '1', '-', '-loglevel', 'error'
        ]
      }
    } else if (process.platform === 'darwin') {
      const sysDev = cfg?.voice?.systemAudioDevice
      if (captureSystemAudio && sysDev) {
        ffmpegArgs = [
          '-f', 'avfoundation', '-i', ':0',
          '-f', 'avfoundation', '-i', ':1',
          '-filter_complex', '[0:a][1:a]amerge=inputs=2[aout]',
          '-map', '[aout]', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'
        ]
      } else {
        ffmpegArgs = [
          '-f', 'avfoundation', '-i', ':1',
          '-f', 's16le', '-ar', '16000', '-ac', '1', '-', '-loglevel', 'error'
        ]
      }
    } else {
      logErr("Unsupported platform for mic capture")
      micSTTActive = false
      return
    }

    const proc = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "ignore"] })
    micSTTProc = proc

    // Read stdout → push frames to STT in real-time
    ;(async () => {
      try {
        let flushSamples = 0
        for await (const chunk of proc.stdout) {
          if (!micSTTActive || proc.killed) break
          const view = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2)
          stream.pushFrame(new AudioFrame(view, 16000, 1, view.length))
          flushSamples += view.length
          if (flushSamples >= 3200) { stream.flush(); flushSamples = 0 }
        }
      } catch (e) {
        if (micSTTActive) logErr("Mic capture stream", e)
      } finally {
        try { stream.flush() } catch {}
      }
    })()
  }

  // Collect transcript events → panel IPC
  ;(async () => {
    try {
      for await (const ev of stream) {
        if (!micSTTActive) break
        if (ev.type === 0) {
          panel?.webContents.send("transcript", { text: "", isFinal: false, startOfSpeech: true })
          if (ttsCtl) { ttsCtl.abort(); ttsCtl = null }
          if (ttsInst) { try { ttsInst.close().catch(() => {}) } catch {}; ttsInst = null }
          panel?.webContents.send("tts_stop", {})
        } else if (ev.type === 2) {
          const t = ev.alternatives?.[0]?.text
          if (t) {
            micCommitted += (micCommitted ? " " : "") + t
            panel?.webContents.send("transcript", { text: micCommitted, isFinal: true, fromBar: barMicActive })
          }
        } else if (ev.type === 1) {
          const t = ev.alternatives?.[0]?.text
          if (t) {
            const display = micCommitted + (micCommitted && t ? " " : "") + t
            panel?.webContents.send("transcript", { text: display, isFinal: false, fromBar: barMicActive })
          }
        } else if (ev.type === 3) {
          // END_OF_SPEECH — user stopped speaking, signal renderer for auto-submit
          panel?.webContents.send("end_of_speech", { text: micCommitted, fromBar: barMicActive })
        }
      }
    } catch (e) {
      if (micSTTActive) logErr("Mic transcript stream", e)
    }
  })()
}

function stopContinuousMic() {
  micSTTActive = false
  if (micSTTProc) { micSTTProc.kill("SIGKILL"); micSTTProc = null }
  if (micSTTStream) { try { micSTTStream.close() } catch {}; micSTTStream = null }
  if (micSTTInstance) { try { micSTTInstance.close() } catch {}; micSTTInstance = null }
  micCommitted = ""
}

function startMicCapture() {
  stopMicCapture() // Clean up old process if any
  startContinuousMic()
}

function stopMicCapture() {
  stopContinuousMic()
  if (!micProcess) return
  log("Mic: stopping legacy process")
  micProcess.kill("SIGTERM")
  setTimeout(() => { if (micProcess) micProcess.kill("SIGKILL") }, 2000)
}

// Push PCM data from renderer (getUserMedia) to LiveKit STT stream
async function pushSTTFrame(data: number[]) {
  if (!micSTTStream) return
  const { AudioFrame } = await import("@livekit/rtc-node")
  const pcm = new Int16Array(data)
  micSTTStream.pushFrame(new AudioFrame(pcm, 16000, 1, pcm.length))
  micSTTFlushSamples += pcm.length
  if (micSTTFlushSamples >= 3200) { micSTTStream.flush(); micSTTFlushSamples = 0 }
}

// Renderer-path STT helpers for separate streams (mic-speaker-streamer pattern)
async function startSysSTT() {
  if (sysOn) return
  sysOn = true
  sysT = ""
  const cfg = readCfg()
  const vc = cfg?.voice || {}
  const model = vc?.stt?.model || "deepgram/nova-3"
  if (!vc?.livekit?.url || !vc?.livekit?.api_key || !vc?.livekit?.api_secret) {
    logErr("LiveKit not configured for streaming STT"); sysOn = false; return
  }
  const { AudioFrame } = await import("@livekit/rtc-node")
  const stt = new inference.STT({
    model: model as any, language: "en" as any,
    apiKey: vc.livekit.api_key, apiSecret: vc.livekit.api_secret,
    encoding: "pcm_s16le", sampleRate: 16000,
  })
  const stream = stt.stream()
  sysI = stt; sysS = stream
  ;(async () => {
    try {
      for await (const ev of stream) {
        if (!sysOn) break
        if (ev.type === 0) {
          panel?.webContents.send("transcript", { text: "", isFinal: false, startOfSpeech: true })
          if (ttsCtl) { ttsCtl.abort(); ttsCtl = null }
          if (ttsInst) { try { ttsInst.close().catch(() => {}) } catch {}; ttsInst = null }
          panel?.webContents.send("tts_stop", {})
        } else if (ev.type === 2) {
          const t = ev.alternatives?.[0]?.text
          if (t) { sysT += (sysT ? " " : "") + t; panel?.webContents.send("transcript", { text: sysT, isFinal: true, fromBar: barMicActive }) }
        } else if (ev.type === 1) {
          const t = ev.alternatives?.[0]?.text
          if (t) { panel?.webContents.send("transcript", { text: sysT + (sysT && t ? " " : "") + t, isFinal: false, fromBar: barMicActive }) }
        } else if (ev.type === 3) {
          panel?.webContents.send("end_of_speech", { text: sysT, fromBar: barMicActive })
        }
      }
    } catch (e) { if (sysOn) logErr("Sys STT stream", e) }
  })()
}

function stopSysSTT() {
  sysOn = false
  if (sysS) { try { sysS.close() } catch {}; sysS = null }
  if (sysI) { try { sysI.close() } catch {}; sysI = null }
  sysT = ""
}

async function startMicSTT() {
  if (micOn) return
  micOn = true
  micT = ""
  const cfg = readCfg()
  const vc = cfg?.voice || {}
  const model = vc?.stt?.model || "deepgram/nova-3"
  if (!vc?.livekit?.url || !vc?.livekit?.api_key || !vc?.livekit?.api_secret) {
    logErr("LiveKit not configured for streaming STT"); micOn = false; return
  }
  const { AudioFrame } = await import("@livekit/rtc-node")
  const stt = new inference.STT({
    model: model as any, language: "en" as any,
    apiKey: vc.livekit.api_key, apiSecret: vc.livekit.api_secret,
    encoding: "pcm_s16le", sampleRate: 16000,
  })
  const stream = stt.stream()
  micI = stt; micS = stream
  ;(async () => {
    try {
      for await (const ev of stream) {
        if (!micOn) break
        if (ev.type === 0) {
          if (ttsCtl) { ttsCtl.abort(); ttsCtl = null }
          if (ttsInst) { try { ttsInst.close().catch(() => {}) } catch {}; ttsInst = null }
          panel?.webContents.send("tts_stop", {})
        } else if (ev.type === 2) {
          const t = ev.alternatives?.[0]?.text
          if (t) { micT += (micT ? " " : "") + t; panel?.webContents.send("transcript", { text: micT, isFinal: true, fromBar: barMicActive }) }
        } else if (ev.type === 1) {
          const t = ev.alternatives?.[0]?.text
          if (t) { panel?.webContents.send("transcript", { text: micT + (micT && t ? " " : "") + t, isFinal: false, fromBar: barMicActive }) }
        } else if (ev.type === 3) {
          panel?.webContents.send("end_of_speech", { text: micT, fromBar: barMicActive })
        }
      }
    } catch (e) { if (micOn) logErr("Mic STT stream", e) }
  })()
}

function stopMicSTT() {
  micOn = false
  if (micS) { try { micS.close() } catch {}; micS = null }
  if (micI) { try { micI.close() } catch {}; micI = null }
  micT = ""
}

async function pushSysSTTFrame(data: number[]) {
  if (!sysS) return
  const { AudioFrame } = await import("@livekit/rtc-node")
  const pcm = new Int16Array(data)
  sysS.pushFrame(new AudioFrame(pcm, 16000, 1, pcm.length))
  sysF += pcm.length
  if (sysF >= 3200) { sysS.flush(); sysF = 0 }
}

async function pushMicSTTFrame(data: number[]) {
  if (!micS) return
  const { AudioFrame } = await import("@livekit/rtc-node")
  const pcm = new Int16Array(data)
  micS.pushFrame(new AudioFrame(pcm, 16000, 1, pcm.length))
  micF += pcm.length
  if (micF >= 3200) { micS.flush(); micF = 0 }
}

function saveConversation() {
  const { dialog } = require('electron')
  const { writeFile } = require('fs').promises
  
  // Generate a title for the conversation using the TUI's title model approach
  // For now, we'll use a simple timestamp-based title
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const defaultTitle = `handofai-conversation-${timestamp}`
  
  // Generate markdown content
  let markdown = `# ${defaultTitle}\n\n`
  
  if (conversationHistory.length === 0) {
    markdown += "*No conversation yet*\n"
  } else {
    conversationHistory.forEach((msg, index) => {
      const role = msg.role === 'user' ? 'User' : 'Assistant'
      markdown += `## ${role}\n\n${msg.text}\n\n`
    })
  }
  
  // Show save dialog
  dialog.showSaveDialog({
    title: 'Save Conversation',
    defaultPath: path.join(os.homedir(), 'Desktop', `${defaultTitle}.md`),
    filters: [
      { name: 'Markdown Files', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  }).then(result => {
    if (!result.canceled && result.filePath) {
      writeFile(result.filePath, markdown).then(() => {
        log(`Conversation saved to ${result.filePath}`)
      }).catch(err => {
        logErr("Failed to save conversation file", err)
      })
    }
  }).catch(err => {
    logErr("Failed to show save dialog", err)
  })
}

function saveConfigToFile() {
  try {
    const cfgPath = findCfgPath()
    if (cfgPath) {
      const fullCfg = JSON.parse(stripJSONC(fs.readFileSync(cfgPath, "utf-8")))
      if (!fullCfg.voice) fullCfg.voice = {}
      fullCfg.voice.captureSystemAudio = guideConfig.captureSystemAudio ?? true
      if (guideConfig.systemAudioDevice) fullCfg.voice.systemAudioDevice = guideConfig.systemAudioDevice
      fs.writeFileSync(cfgPath, JSON.stringify(fullCfg, null, 2))
    }
  } catch (e) { logErr("Failed to save config", e) }
}

function saveGuideConfig() {
  try {
    fs.writeFileSync(guideStatePath, JSON.stringify({
      adviceDuration: guideConfig.adviceDuration,
      screenshotInterval: guideConfig.screenshotInterval,
      silenceTimeout: guideConfig.silenceTimeout,
    }, null, 2))
  } catch (e) { logErr("Failed to save guide config", e) }
}

// --- Guide mode ---

function startGuideMode() {
  if (guideInterval) return
  guideRunning = true
  guideErrors = 0
  guideInterval = setInterval(captureScreenshot, guideConfig.screenshotInterval)
  log("Guide mode started")
}

function stopGuideMode() {
  if (!guideInterval && !guideRunning) return
  guideRunning = false
  guideErrors = 0
  if (guideInterval) { clearInterval(guideInterval); guideInterval = null }
  log("Guide mode stopped")
}

// --- Window helpers ---

function enforceAlwaysOnTop(win: BrowserWindow) {
  if (!win.isDestroyed()) win.setAlwaysOnTop(true)
}

function setupStealthEvents(win: BrowserWindow) {
  win.on("blur", () => setTimeout(() => enforceAlwaysOnTop(win), 50))
  win.on("show", () => setTimeout(() => enforceAlwaysOnTop(win), 50))
  win.on("focus", () => setTimeout(() => enforceAlwaysOnTop(win), 50))
  win.on("restore", () => setTimeout(() => enforceAlwaysOnTop(win), 50))
}

async function createBar() {
  const workArea = screen.getPrimaryDisplay().workArea
  bar = new BrowserWindow({
    width: 520, height: 44,
    x: Math.round((workArea.width - 520) / 2), y: workArea.y,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, show: false,
    hasShadow: false, thickFrame: false,
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      nodeIntegration: false, contextIsolation: true,
    },
  })
  setupStealthEvents(bar)
  bar.setVisibleOnAllWorkspaces(true)
  bar.setContentProtection(true)
  bar.on("closed", () => { bar = null; panel?.close() })
  await bar.loadFile(path.join(ROOT, "overlay", "index.html"))
}

async function createPanel() {
  const workArea = screen.getPrimaryDisplay().workArea
  panel = new BrowserWindow({
    width: 500, height: 600,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: true, show: false,
    hasShadow: true, thickFrame: true,
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      nodeIntegration: false, contextIsolation: true,
    },
  })
  setupStealthEvents(panel)
  panel.setVisibleOnAllWorkspaces(true)
  panel.setContentProtection(true)
  panel.setPosition(Math.round((workArea.width - 500) / 2), workArea.y + 48)
  panel.on("closed", () => { panel = null; bar?.close() })
  await panel.loadFile(path.join(ROOT, "overlay", "index.html"), { hash: "panel" })
  panel.webContents.setWindowOpenHandler(({ url }) => {
    const w = new BrowserWindow({
      width: 1024, height: 768,
      transparent: true, frame: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: true, show: false,
      hasShadow: false, thickFrame: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    setupStealthEvents(w)
    w.setContentProtection(true)
    w.setVisibleOnAllWorkspaces(true)
    w.webContents.on("before-input-event", (_, input) => {
      if (input.key === "Escape" && !w.isDestroyed()) w.close()
    })
    w.loadURL(url)
    w.show()
    return { action: "deny" }
  })
}



function clampToDisplay() {
  const clamp = (win: BrowserWindow) => {
    if (win.isDestroyed()) return
    const wa = screen.getPrimaryDisplay().workArea
    const b = win.getBounds()
    const cx = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - Math.min(b.width, wa.width)))
    const cy = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - Math.min(b.height, wa.height)))
    if (cx !== b.x || cy !== b.y) win.setPosition(cx, cy)
  }
  if (bar) clamp(bar)
  if (panel) clamp(panel)
}

function positionWindows() {
  if (!bar) return
  const workArea = screen.getPrimaryDisplay().workArea
  const barBounds = bar.getBounds()
  bar.setPosition(Math.round((workArea.width - barBounds.width) / 2), workArea.y)
  if (panel) {
    panel.setPosition(Math.round((workArea.width - panel.getBounds().width) / 2), workArea.y + barBounds.height + 4)
  }
}

function toggleInteractive() {
  isInteractive = !isInteractive
  const set = (w: BrowserWindow | null) => {
    if (w && !w.isDestroyed()) {
      if (isInteractive) w.setIgnoreMouseEvents(false)
      else w.setIgnoreMouseEvents(true, { forward: true })
      w.webContents.send("interaction_mode", isInteractive)
    }
  }
  set(bar); set(panel)
}

function moveWindows(dx: number, dy: number) {
  if (!bar) return
  const [bx, by] = [bar.getBounds().x, bar.getBounds().y]
  const nx = Math.max(0, bx + dx)
  const ny = Math.max(0, by + dy)
  bar.setPosition(nx, ny)
  if (panel) {
    const [px, py] = [panel.getBounds().x, panel.getBounds().y]
    panel.setPosition(px + (nx - bx), py + (ny - by))
  }
}

// --- Screen share detection ---

function startScreenShareDetection() {
  screenShareInterval = setInterval(async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
      const numDisplays = screen.getAllDisplays().length
      const detected = sources.length > numDisplays
      // Only hide windows if NOT in guide mode (to allow guide mode to work with screen capture)
      if (detected && bar && !bar.isDestroyed() && !guideRunning) {
        bar.setPosition(-10000, -10000); bar.hide()
        if (panel && !panel.isDestroyed()) { panel.setPosition(-10000, -10000); panel.hide() }
      } else if (!detected && visible && bar) {
        bar.show()
        if (chatWindowVisible) panel?.show()
      }
    } catch (e) { logErr("Screen share detection", e) }
  }, 5000)
}

// --- IPC handlers ---

ipcMain.on("action", (_e, name: string, data: any) => {
  switch (name) {
    case "drag_move":
      if (bar && !bar.isDestroyed()) {
        const p = bar.getPosition()
        bar.setPosition(p[0] + data.deltaX, p[1] + data.deltaY)
        if (panel && !panel.isDestroyed()) {
          const q = panel.getPosition()
          panel.setPosition(q[0] + data.deltaX, q[1] + data.deltaY)
        }
      }
      break
    case "panel_drag_move":
      if (panel && !panel.isDestroyed()) {
        const p = panel.getPosition()
        panel.setPosition(p[0] + data.deltaX, p[1] + data.deltaY)
      }
      break
    case "screenshot":
      captureScreenshot()
      break
     case "resize_bar":
       if (bar && !bar.isDestroyed()) {
         const h = Math.max(44, Math.min(300, data.height || 250))
         const [x, y] = bar.getPosition()
         bar.setBounds({ x, y, width: 520, height: h })
       }
       break
      case "resize_panel":
        if (panel && !panel.isDestroyed()) {
          let w = Math.max(300, Math.min(1200, data.width || data.w || 500))
          let h = Math.max(300, Math.min(1000, data.height || data.h || 600))
          const [x, y] = panel.getPosition()
          const edge = data.edge || "se"
          let nx = data.startWX ?? x, ny = data.startWY ?? y
          if (edge.includes("w")) nx = (data.startWX ?? x) + ((data.startW || w) - w)
          if (edge.includes("n")) ny = (data.startWY ?? y) + ((data.startH || h) - h)
          panel.setBounds({ x: nx, y: ny, width: w, height: h })
          try { fs.writeFileSync(path.join(stateDir, "panel-bounds.json"), JSON.stringify(panel.getBounds())) } catch {}
        }
        break
    case "guide_mode":
      if (data?.active) startGuideMode()
      else stopGuideMode()
      break
    case "tts_synthesize":
      if (data?.text) doTTS(data.text)
      break
    case "tts_stop":
      if (ttsCtl) { ttsCtl.abort(); ttsCtl = null }
      if (ttsInst) { try { ttsInst.close().catch(() => {}) } catch {}; ttsInst = null }
      break
    case "renderer_log":
      log(`[Renderer] ${data?.msg}`)
      break
    case "voice_debug":
      log(`[VoiceDebug] ${data?.msg}`)
      break
    case "stt_audio_sys":
      if (data?.data) pushSysSTTFrame(data.data)
      break
    case "stt_audio_mic":
      if (data?.data) pushMicSTTFrame(data.data)
      break
    case "voice_input":
      if (data?.text) processUserInput(data.text, true).catch(e => logErr("Voice input processing failed", e)) // true = from speech
      break
    case "voice_toggle": {
      const cfg = readCfg()
      const vc = cfg?.voice || {}
      const current = vc?.mode || "off"
      vc.mode = current === "off" ? "stt_only" : "off"
      try {
        const cfgPath = findCfgPath()
        if (cfgPath) {
      const fullCfg = JSON.parse(stripJSONC(fs.readFileSync(cfgPath, "utf-8")))
          fullCfg.voice = vc
          fs.writeFileSync(cfgPath, JSON.stringify(fullCfg, null, 2))
        }
      } catch (e) { logErr("voice_toggle config write", e) }
      if (vc.mode === "stt_only") startMicCapture()
      else stopMicCapture()
      break
    }
    case "close":
      app.quit()
      break
    case "save_conversation":
      saveConversation()
      break
    case "start_dictation":
      barMicActive = data?.fromBar || false
      appState.dictationActive = true
      appState.mic = true
      startSysSTT()
      if (data?.useMic) startMicSTT()
      break
    case "stop_dictation":
      barMicActive = false
      appState.dictationActive = false
      stopSysSTT()
      stopMicSTT()
      break
    case "clear_mic_committed":
      sysT = ""; micT = ""; micCommitted = ""
      break
    case "stealth_toggle":
      if (data?.enabled !== undefined) {
        [bar, panel].forEach(win => {
          if (win && !win.isDestroyed()) win.setContentProtection(data.enabled)
        })
      }
      break
  }
})

ipcMain.on("settings_change", (_e, key: string, value: any) => {
  if (key === "guide") {
    if (value) startGuideMode()
    else stopGuideMode()
  } else if (key === "mic") {
    appState.mic = !!value
    barMicActive = !!value
  } else if (key === "adviceDuration") {
    guideConfig.adviceDuration = Number(value)
    saveGuideConfig()
  } else if (key === "screenshotInterval") {
    guideConfig.screenshotInterval = Number(value)
    if (guideRunning && guideInterval) {
      clearInterval(guideInterval)
      guideInterval = setInterval(captureScreenshot, guideConfig.screenshotInterval)
    }
    saveGuideConfig()
    bar?.webContents.send("settings", { screenshotInterval: Number(value) })
    panel?.webContents.send("settings", { screenshotInterval: Number(value) })
  } else if (key === "tts") {
    ttsEnabled = !!value
    panel?.webContents.send("settings", { tts: ttsEnabled })
  } else if (key === "stealthMode") {
    [bar, panel].forEach(win => {
      if (win && !win.isDestroyed()) win.setContentProtection(!!value)
    })
    bar?.webContents.send("settings", { stealthMode: !!value })
  } else if (key === "chatWindowVisible") {
    chatWindowVisible = !!value
    if (panel && !panel.isDestroyed()) {
      if (value && visible) panel.show()
      else panel.hide()
    }
  } else if (key === "captureSystemAudio") {
    guideConfig.captureSystemAudio = !!value
    bar?.webContents.send("settings", { captureSystemAudio: !!value })
    panel?.webContents.send("settings", { captureSystemAudio: !!value })
    saveConfigToFile()
  } else if (key === "systemAudioDevice") {
    saveConfigToFile()
  } else if (key === "silenceTimeout") {
    guideConfig.silenceTimeout = Number(value)
    saveGuideConfig()
    bar?.webContents.send("settings", { silenceTimeout: Number(value) })
    panel?.webContents.send("settings", { silenceTimeout: Number(value) })
  } else if (key === "webSearch") {
    webSearchEnabled = !!value
    bar?.webContents.send("settings", { webSearch: !!value })
    panel?.webContents.send("settings", { webSearch: !!value })
  }
})

ipcMain.on("chat", async (_e, text: string) => {
  if (!text) return
  try { await processUserInput(text, false) }
  catch (e) { logErr("Chat handler", e) }
})

ipcMain.on("toggle_visibility", () => {
  visible = !visible
  if (visible) {
    bar?.show()
    if (chatWindowVisible) panel?.show()
  } else {
    bar?.hide()
    panel?.hide()
  }
})

ipcMain.on("clickable_area", (e, active: boolean) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (w && !w.isDestroyed()) {
    if (active) w.setIgnoreMouseEvents(false)
    else w.setIgnoreMouseEvents(true, { forward: true })
  }
})

// --- App lifecycle ---

app.whenReady().then(async () => {
  log("Electron ready. Building provider state...")
  try {
    const s = await buildState()
    log(`State built: ${Object.keys(s.providers).length} providers`)
    const resolved = await resolveCompanionModel()
    log(`Companion model: ${resolved ? `${resolved.pid}/${resolved.mid}` : "none"}`)
    const vision = await resolveVisionModel()
    log(`Vision model: ${vision ? `${vision.pid}/${vision.mid}` : "none"}`)
  } catch (e) {
    logErr("State init failed", e)
  }

  log("Creating windows...")
  await createBar()
  await createPanel()
  // Restore saved panel bounds
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "panel-bounds.json"), "utf-8"))
    if (saved?.width && saved?.height) panel?.setBounds(saved)
  } catch {}
  startScreenShareDetection()
  positionWindows()

  bar!.setVisibleOnAllWorkspaces(true)
  bar!.setAlwaysOnTop(true)
  panel!.setVisibleOnAllWorkspaces(true)
  panel!.setAlwaysOnTop(true)
  log("Windows hidden. Ctrl+Shift+V to show.")

  screen.on("display-metrics-changed", clampToDisplay)

   const cfg = readCfg()
   const vc = cfg?.voice || {}
   
   // Load guide mode configuration from companion state
   try {
     const gd = JSON.parse(fs.readFileSync(guideStatePath, "utf-8"))
      if (gd.adviceDuration !== undefined) guideConfig.adviceDuration = gd.adviceDuration
      if (gd.screenshotInterval !== undefined) guideConfig.screenshotInterval = gd.screenshotInterval
      if (gd.silenceTimeout !== undefined) guideConfig.silenceTimeout = gd.silenceTimeout
    } catch {}

   // Load voice configuration from config
   if (cfg?.voice) {
     if (cfg.voice.captureSystemAudio !== undefined) guideConfig.captureSystemAudio = cfg.voice.captureSystemAudio
     if (cfg.voice.systemAudioDevice) guideConfig.systemAudioDevice = cfg.voice.systemAudioDevice
   }
   
   ttsEnabled = vc?.mode !== "off"
   const settings = { 
     guide: false, 
     tts: ttsEnabled, 
     webSearch: webSearchEnabled, 
     mic: vc?.mode !== "off",
     stealthMode: true,
     chatWindowVisible,
     adviceDuration: guideConfig.adviceDuration,
     screenshotInterval: guideConfig.screenshotInterval,
      captureSystemAudio: guideConfig.captureSystemAudio,
      systemAudioDevice: guideConfig.systemAudioDevice,
      silenceTimeout: guideConfig.silenceTimeout
    }
    panel?.webContents.send("settings", settings)
    bar?.webContents.send("settings", settings)
   log(`Config loaded: voice.mode=${vc?.mode}, tts=${vc?.tts?.model}`)

  log("Registering shortcuts...")
  globalShortcut.register("CommandOrControl+Shift+S", captureScreenshot)
  globalShortcut.register("CommandOrControl+Shift+V", () => {
    visible = !visible
    if (visible) {
      bar?.show()
      if (chatWindowVisible) panel?.show()
    } else {
      bar?.hide()
      panel?.hide()
    }
  })
  globalShortcut.register("CommandOrControl+Shift+I", toggleInteractive)
  globalShortcut.register("Alt+A", toggleInteractive)
  globalShortcut.register("Escape", () => { if (!isInteractive) toggleInteractive() })
  globalShortcut.register("CommandOrControl+Up", () => { if (!isInteractive) moveWindows(0, -20) })
  globalShortcut.register("CommandOrControl+Down", () => { if (!isInteractive) moveWindows(0, 20) })
  globalShortcut.register("CommandOrControl+Left", () => { if (!isInteractive) moveWindows(-20, 0) })
  globalShortcut.register("CommandOrControl+Right", () => { if (!isInteractive) moveWindows(20, 0) })
  globalShortcut.register("Alt+R", () => {
    const cfg2 = readCfg()
    const vc2 = cfg2?.voice || {}
    if ((vc2?.mode || "off") === "off") startMicCapture()
    else stopMicCapture()
  })
  log("Shortcuts registered")
  log("Companion ready")
}).catch((e: any) => {
  logErr("Startup failed", e)
  app.quit()
})

app.on("will-quit", () => {
  log("=== Session ending ===")
  globalShortcut.unregisterAll()
  if (screenShareInterval) clearInterval(screenShareInterval)
  if (guideInterval) clearInterval(guideInterval)
  stopMicCapture()
})

app.on("window-all-closed", () => {
  log("All windows closed, quitting")
  app.quit()
})
