import { WebSocketServer, WebSocket } from "ws"
import { EventEmitter } from "events"
import { Provider } from "@/provider/provider"
import type { ModelID } from "@/provider/schema"
import { generateText, type ModelMessage } from "ai"
import fs from "fs"
import os from "os"
import path from "path"
import { Global } from "@/global"

interface PendingCommand {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

interface LangChainAIMessage {
  _getType: () => string
  content: string
  additional_kwargs: Record<string, unknown>
  response_metadata: Record<string, unknown>
  name?: string
  tool_calls?: Array<{ name: string; args: Record<string, unknown>; id?: string }>
  invalid_tool_calls?: unknown[]
  usage_metadata?: unknown
}

// PID file management for single global bridge process
function pidFile(): string {
  return path.join(os.tmpdir(), "handofai-bridge-18889.pid")
}

function writePidFile(pid: number) {
  try {
    fs.writeFileSync(pidFile(), String(pid), { flag: "w" })
  } catch {}
}

function clearPidFile() {
  try {
    if (fs.existsSync(pidFile())) {
      fs.unlinkSync(pidFile())
    }
  } catch {}
}

function readPidFile(): number | null {
  try {
    const raw = fs.readFileSync(pidFile(), "utf8").trim()
    const pid = parseInt(raw, 10)
    if (!isNaN(pid)) return pid
  } catch {}
  return null
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcess(pid: number) {
  try {
    if (process.platform === "win32") {
      const { execSync } = require("child_process")
      execSync(`taskkill /PID ${pid} /F 2>nul`, { stdio: "ignore" })
    } else {
      process.kill(pid, "SIGTERM")
    }
  } catch {}
}

// Cleanup on process exit
function setupCleanup() {
  const cleanup = () => {
    const ownerPid = readPidFile()
    if (ownerPid === process.pid) {
      clearPidFile()
    }
  }

  process.on("exit", cleanup)
  process.on("SIGINT", () => { cleanup(); process.exit(0) })
  process.on("SIGTERM", () => { cleanup(); process.exit(0) })
  process.on("uncaughtException", () => { cleanup() })
}

export class NanoBrowserBridge extends EventEmitter {
  private static instance: NanoBrowserBridge | null = null
  private wss: WebSocketServer | null = null
  private ws: WebSocket | null = null
  private client: WebSocket | null = null
  private clientProxies = new Map<WebSocket, WebSocket>()
  private commandId = 0
  private pendingCommands = new Map<string, PendingCommand>()
  private port: number
  private started = false
  private owner = false
  private mode: "server" | "client" | "uninitialized" = "uninitialized"

  static getInstance(port = 18889): NanoBrowserBridge {
    if (!NanoBrowserBridge.instance) {
      NanoBrowserBridge.instance = new NanoBrowserBridge(port)
      setupCleanup()
    }
    return NanoBrowserBridge.instance
  }

  private constructor(port: number) {
    super()
    this.port = port
  }

  /**
   * Check if this process is the bridge owner (the one running the WebSocket server)
   */
  isOwner(): boolean {
    return this.owner
  }

  /**
   * Get the current mode: "server" (owner), "client" (proxying to owner), or "uninitialized"
   */
  getMode(): "server" | "client" | "uninitialized" {
    return this.mode
  }

  /**
   * Initialize the bridge - either as owner (server) or client (proxy to owner)
   * Returns the port if successful
   */
  async start(): Promise<number> {
    // Check if there's already an owner process
    const existingPid = readPidFile()

    if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) {
      // Another process owns the bridge - connect as client
      const connected = await this.connectAsClient()
      if (connected) {
        this.mode = "client"
        this.owner = false
        this.started = true
        return this.port
      }
      // Owner PID is stale or connection failed - clean up and try to become owner
      clearPidFile()
    }

    // Try to become the owner
    const canOwn = await this.tryBecomeOwner()
    if (canOwn) {
      this.mode = "server"
      this.owner = true
      this.started = true
      writePidFile(process.pid)
      return this.port
    }

    // Failed to become owner - try connecting as client one more time
    const connected = await this.connectAsClient()
    if (connected) {
      this.mode = "client"
      this.owner = false
      this.started = true
      return this.port
    }

    throw new Error("Failed to initialize bridge: could not start server or connect to existing owner")
  }

  /**
   * Try to start the WebSocket server and become the owner
   */
  private tryBecomeOwner(): Promise<boolean> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port })

      this.wss.on("listening", () => {
        resolve(true)
      })

      this.wss.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          resolve(false)
        }
      })

      this.wss.on("connection", (ws: WebSocket) => {
        ws.on("message", async (data: string) => {
          try {
            const message = JSON.parse(data)

            // Client requesting status
            if (message.type === "status") {
              ws.send(JSON.stringify({
                type: "status",
                connected: this.client !== null && this.client.readyState === WebSocket.OPEN,
                owner: true,
              }))
              return
            }

            // NanoBrowser extension ready
            if (message.type === "ready") {
              this.client = ws
              this.emit("connected")

              // Send provider config to extension
              await this.sendProviderConfig(ws)

              // Notify all client proxies
              for (const [proxyWs] of this.clientProxies) {
                if (proxyWs.readyState === WebSocket.OPEN) {
                  proxyWs.send(JSON.stringify({ type: "extension_connected" }))
                }
              }
              return
            }

            // Client proxy forwarding a command
            if (message.type === "execute_task" && message.id) {
              if (this.client && this.client.readyState === WebSocket.OPEN) {
                // Track which client sent this command (key=extension, value=client)
                this.clientProxies.set(this.client, ws)
                // Forward to NanoBrowser extension
                this.client.send(JSON.stringify(message))
              } else {
                ws.send(JSON.stringify({
                  type: "result",
                  id: message.id,
                  success: false,
                  error: "NanoBrowser not connected",
                }))
              }
              return
            }

            // Result from NanoBrowser extension
            if (message.type === "result" && message.id) {
              // Resolve pending command for this process
              const pending = this.pendingCommands.get(message.id)
              if (pending) {
                if (pending.timeout) clearTimeout(pending.timeout)
                this.pendingCommands.delete(message.id)
                pending.resolve(message)
              }

              // Forward to the client proxy that sent the command
              const proxyWs = this.clientProxies.get(ws)
              if (proxyWs && proxyWs.readyState === WebSocket.OPEN) {
                proxyWs.send(JSON.stringify(message))
              }
              return
            }

            // LLM request from extension
            if (message.type === "llm_request") {
              await this.handleLlmRequest(message)
            }
            
            // Execution event from extension (streaming progress)
            if (message.type === "execution_event") {
              this.emit("execution_event", message.event)
              
              // Forward to all client proxies
              for (const [, proxyWs] of this.clientProxies) {
                if (proxyWs.readyState === WebSocket.OPEN) {
                  proxyWs.send(JSON.stringify(message))
                }
              }
            }
          } catch {}
        })

        ws.on("close", () => {
          if (this.client === ws) {
            this.client = null
            this.emit("disconnected")
          }
          this.clientProxies.delete(ws)
        })
      })
    })
  }

  private async isPortInUse(): Promise<boolean> {
    try {
      const conn = await import("net").then(net => {
        return new Promise<boolean>((resolve) => {
          const socket = new net.Socket()
          socket.setTimeout(1000)
          socket.on("connect", () => {
            socket.destroy()
            resolve(true)
          })
          socket.on("error", () => resolve(false))
          socket.on("timeout", () => {
            socket.destroy()
            resolve(false)
          })
          socket.connect(this.port, "localhost")
        })
      })
      return conn
    } catch {
      return false
    }
  }

  /**
   * Connect to an existing bridge owner as a client
   */
  async connectAsClient(): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${this.port}`)

      ws.on("open", () => {
        // Request status to verify server is alive
        ws.send(JSON.stringify({ type: "status" }))
      })

      ws.on("message", (data: string) => {
        try {
          const message = JSON.parse(data)

          if (message.type === "status" && message.owner) {
            // Successfully connected to owner
            this.ws = ws

            if (message.connected) {
              // Extension is already connected
              this.emit("connected")
            }

            resolve(true)
            return
          }

          if (message.type === "extension_connected") {
            this.emit("connected")
            return
          }

          if (message.type === "result" && message.id) {
            const pending = this.pendingCommands.get(message.id)
            if (pending) {
              if (pending.timeout) clearTimeout(pending.timeout)
              this.pendingCommands.delete(message.id)
              pending.resolve(message)
            }
            return
          }

          if (message.type === "llm_request") {
            this.handleLlmRequest(message)
          }

          // Forward execution events from extension (for progress updates)
          if (message.type === "execution_event") {
            this.emit("execution_event", message.event)
          }
        } catch {}
      })

      ws.on("close", () => {
        this.ws = null
        this.emit("disconnected")
      })

      ws.on("error", () => {
        resolve(false)
      })

      // Timeout after 3 seconds
      setTimeout(() => {
        if (!this.ws) {
          try { ws.close() } catch {}
          resolve(false)
        }
      }, 3000)
    })
  }

  private async handleLlmRequest(message: any) {
    const { id, messages, parameters } = message

    try {
      // Use HandOfAI's configured vision model instead of extension's requested model
      const vision = await this.getVisionModel()
      if (!vision) {
        throw new Error(
          "No vision model configured. Please configure a vision model in HandOfAI TUI by pressing '/' and selecting 'Switch vision model', or run: handofaicli vision <provider>/<model>"
        )
      }

      console.log(`[Bridge] Using vision model: ${vision.providerID}/${vision.modelID}`)
      const response = await this.callProvider(vision.providerID, vision.modelID, messages, parameters)
      this.client?.send(JSON.stringify({ type: "llm_response", id, response }))
    } catch (err) {
      console.error(`[Bridge] LLM request failed:`, err)
      this.client?.send(JSON.stringify({
        type: "llm_error",
        id,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  private async getVisionModel(): Promise<{ providerID: string; modelID: string } | null> {
    try {
      const statePath = path.join(Global.Path.state, "model.json")
      if (!fs.existsSync(statePath)) return null

      const content = fs.readFileSync(statePath, "utf8")
      const state = JSON.parse(content)

      if (state.visionModel?.providerID && state.visionModel?.modelID) {
        return {
          providerID: state.visionModel.providerID,
          modelID: state.visionModel.modelID,
        }
      }

      return null
    } catch {
      return null
    }
  }

  private async callProvider(
    providerID: string,
    modelID: string,
    messages: any[],
    parameters: Record<string, unknown>,
  ): Promise<any> {
    console.log(`[Bridge] Getting model config for ${providerID}/${modelID}`)
    const modelConfig = await Provider.getModel(providerID as any, modelID as ModelID)
    console.log(`[Bridge] Got model config, getting language`)
    const language = await Provider.getLanguage(modelConfig)
    console.log(`[Bridge] Got language: ${language}`)

    const { coreMessages, systemPrompt } = this.mapMessages(messages)

    const opts: any = {
      model: language,
      messages: coreMessages,
    }

    if (systemPrompt) {
      opts.system = systemPrompt
    }

    if ((parameters as any).temperature !== undefined) opts.temperature = (parameters as any).temperature
    if ((parameters as any).topP !== undefined) opts.topP = (parameters as any).topP
    if ((parameters as any).maxTokens !== undefined) opts.maxTokens = (parameters as any).maxTokens

    console.log(`[Bridge] Calling generateText...`)
    const result = await generateText(opts)
    console.log(`[Bridge] generateText succeeded`)

    return this.mapResponse(result)
  }

  private mapProviderType(nbType: string): string {
    const map: Record<string, string> = {
      "Anthropic": "anthropic",
      "OpenAI": "openai",
      "Gemini": "google",
      "Groq": "groq",
      "DeepSeek": "deepseek",
      "Grok": "xai",
      "Ollama": "ollama",
      "OpenRouter": "openrouter",
      "Cerebras": "cerebras",
      "AzureOpenAI": "azure",
      "Llama": "llama",
      "CustomOpenAI": "openai",
    }
    return map[nbType] ?? "openai"
  }

  private mapMessages(messages: any[]): { coreMessages: ModelMessage[]; systemPrompt?: string } {
    const coreMessages: ModelMessage[] = []
    let systemPrompt: string | undefined

    for (const msg of messages) {
      const type = msg._getType?.() ?? msg.type
      const content = msg.content ?? msg

      if (type === "system") {
        systemPrompt = typeof content === "string" ? content : JSON.stringify(content)
        continue
      }

      if (type === "human") {
        if (typeof content === "string") {
          coreMessages.push({ role: "user", content })
        } else if (Array.isArray(content)) {
          coreMessages.push({ role: "user", content: content.map(part => this.mapContentPart(part)) })
        } else {
          coreMessages.push({ role: "user", content: String(content) })
        }
        continue
      }

      if (type === "ai") {
        const assistantMsg: any = { role: "assistant" as const }
        if (typeof content === "string") {
          assistantMsg.content = content
        } else if (Array.isArray(content)) {
          assistantMsg.content = content.map(part => this.mapContentPart(part))
        } else {
          assistantMsg.content = String(content ?? "")
        }
        if (msg.tool_calls?.length) {
          assistantMsg.toolCalls = msg.tool_calls
        }
        coreMessages.push(assistantMsg)
        continue
      }

      if (type === "tool") {
        coreMessages.push({
          role: "tool" as any,
          content: typeof content === "string" ? content : JSON.stringify(content),
          toolCallId: msg.tool_call_id ?? msg.id ?? "unknown",
        })
        continue
      }

      coreMessages.push({ role: "user", content: String(content) })
    }

    return { coreMessages, systemPrompt }
  }

  private mapContentPart(part: any): any {
    if (typeof part === "string") return { type: "text" as const, text: part }
    if (part.type === "image_url" || part.type === "image") {
      return {
        type: "image" as const,
        image: part.image_url?.url ?? part.image ?? part.data,
      }
    }
    if (part.type === "text") return part
    return { type: "text" as const, text: String(part) }
  }

  private mapResponse(result: any): LangChainAIMessage {
    return {
      _getType: () => "ai",
      content: result.text ?? "",
      additional_kwargs: {},
      response_metadata: {
        finishReason: result.finishReason,
        usage: result.usage,
      },
      tool_calls: result.toolCalls?.map((tc: any) => ({
        name: tc.toolName,
        args: tc.args,
        id: tc.toolCallId,
      })) ?? [],
    }
  }

  /**
   * Wait for the bridge to be ready (either as owner with extension connected, or as client connected to owner)
   */
  private async waitForConnection(maxWaitMs = 15000): Promise<void> {
    const start = Date.now()

    while (Date.now() - start < maxWaitMs) {
      // As owner: check if extension is connected
      if (this.owner && this.client?.readyState === WebSocket.OPEN) {
        return
      }

      // As client: check if connected to owner
      if (!this.owner && this.ws?.readyState === WebSocket.OPEN) {
        return
      }

      await new Promise(r => setTimeout(r, 500))
    }

    throw new Error("NanoBrowser not connected. Make sure the extension is loaded in Chrome.")
  }

  async sendCommand(
    action: string,
    params: Record<string, any>,
    timeout = 120000,
  ): Promise<any> {
    // Wait for connection to be ready
    await this.waitForConnection()

    const id = String(++this.commandId)

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      
      // Only set timeout if timeout > 0 (0 means no timeout)
      if (timeout > 0) {
        timer = setTimeout(() => {
          this.pendingCommands.delete(id)
          reject(new Error(`Command timed out after ${timeout}ms`))
        }, timeout)
      }

      this.pendingCommands.set(id, { resolve, reject, timeout: timer })

      // Send through the appropriate channel
      if (this.owner) {
        // We're the owner - send to extension
        this.client!.send(JSON.stringify({ type: "execute_task", id, ...params }))
      } else {
        // We're a client - send to owner
        this.ws!.send(JSON.stringify({ type: "execute_task", id, ...params }))
      }
    })
  }

  async executeTask(
    task: string,
    onProgress?: (event: { actor: string; state: string; details: string; step: number; maxSteps: number }) => void
  ): Promise<{
    success: boolean
    result: string
    error?: string
  }> {
    // Set up progress listener if callback provided
    const progressHandler = onProgress ? (event: any) => {
      onProgress({
        actor: event.actor,
        state: event.state,
        details: event.data?.details || '',
        step: event.data?.step || 0,
        maxSteps: event.data?.maxSteps || 0,
      })
    } : null
    
    if (progressHandler) {
      this.on("execution_event", progressHandler)
    }
    
    try {
      // No timeout for task execution - let it run as long as needed
      const result = await this.sendCommand("execute_task", { task }, 0)
      return {
        success: result.success,
        result: result.result ?? "",
        error: result.error,
      }
    } finally {
      if (progressHandler) {
        this.off("execution_event", progressHandler)
      }
    }
  }

  isConnected(): boolean {
    // As owner: check if extension is connected
    if (this.owner) {
      return this.client !== null && this.client.readyState === WebSocket.OPEN
    }
    // As client: check if connected to owner and extension is ready
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Send provider config to a connected extension
   */
  private async sendProviderConfig(ws: WebSocket): Promise<void> {
    try {
      const vision = await this.getVisionModel()
      if (!vision) {
        console.log("[Bridge] No vision model configured, skipping provider config")
        return
      }

      const config = await this.buildProviderConfig(vision)
      if (config) {
        ws.send(JSON.stringify({
          type: "provider_config",
          config,
        }))
        console.log(`[Bridge] Sent provider config: ${vision.providerID}/${vision.modelID}`)
      }
    } catch (err) {
      console.error("[Bridge] Failed to send provider config:", err)
    }
  }

  /**
   * Broadcast provider config to all connected extensions
   * Call this when vision model changes
   */
  async broadcastProviderConfig(): Promise<void> {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      console.log("[Bridge] No extension connected, skipping broadcast")
      return
    }

    await this.sendProviderConfig(this.client)
  }

  /**
   * Build provider config for extension
   */
  private async buildProviderConfig(vision: { providerID: string; modelID: string }): Promise<any> {
    try {
      // Read auth config
      const authPath = path.join(Global.Path.data, "auth.json")
      if (!fs.existsSync(authPath)) {
        throw new Error("No auth config found")
      }

      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"))
      const providerAuth = auth[vision.providerID]

      if (!providerAuth) {
        throw new Error(`No auth config for provider: ${vision.providerID}`)
      }

      // Map provider type for extension
      const providerType = this.mapToExtensionType(vision.providerID)
      const baseUrl = this.getProviderBaseUrl(vision.providerID)

      // Build config for extension
      const modelName = vision.modelID.includes("/") 
        ? vision.modelID.split("/").slice(1).join("/")
        : vision.modelID

      return {
        providers: {
          [vision.providerID]: {
            name: vision.providerID,
            type: providerType,
            apiKey: providerAuth.key,
            baseUrl,
            modelNames: [modelName],
          },
        },
        agents: {
          navigator: {
            provider: vision.providerID,
            modelName,
            parameters: { temperature: 0.1, topP: 0.1, maxTokens: 4096 },
          },
          planner: {
            provider: vision.providerID,
            modelName,
            parameters: { temperature: 0.1, topP: 0.1, maxTokens: 4096 },
          },
        },
      }
    } catch (err) {
      console.error("[Bridge] Failed to build provider config:", err)
      return null
    }
  }

  /**
   * Map HandOfAI provider ID to extension provider type
   */
  private mapToExtensionType(providerID: string): string {
    const map: Record<string, string> = {
      kilo: "custom_openai",
      openai: "openai",
      anthropic: "anthropic",
      google: "gemini",
      groq: "groq",
      cerebras: "cerebras",
      deepseek: "deepseek",
      xai: "grok",
      ollama: "ollama",
      openrouter: "openrouter",
    }
    return map[providerID] || "custom_openai"
  }

  /**
   * Get provider base URL for extension
   */
  private getProviderBaseUrl(providerID: string): string | undefined {
    if (providerID === "kilo") {
      return "https://api.kilo.ai/api/gateway"
    }
    return undefined
  }

  async stop(): Promise<void> {
    for (const [, pending] of this.pendingCommands) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(new Error("Bridge shutting down"))
    }
    this.pendingCommands.clear()

    if (this.owner) {
      // Owner cleanup
      if (this.wss) {
        this.wss.close()
        this.wss = null
      }
      this.owner = false
      clearPidFile()
    }

    // Client cleanup
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.client = null
    this.clientProxies.clear()
    this.mode = "uninitialized"
    this.started = false
    NanoBrowserBridge.instance = null
  }
}
