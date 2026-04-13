import z from "zod"
import os from "os"
import path from "path"
import fs from "fs"
import { spawn, spawnSync, type ChildProcess } from "child_process"
import { Tool } from "../tool"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Shell } from "@/shell/shell"
import { which } from "@/util/which"
import { Global } from "@/global"
import DESCRIPTION from "./typescript.txt"

const log = Log.create({ service: "typescript-tool" })

// Constants
const DEFAULT_TIMEOUT = 2 * 60 * 1000 // 2 minutes
const MAX_OUTPUT_LINES = 2000
const MAX_OUTPUT_BYTES = 50 * 1024
const OUTPUT_FENCE = "__TYPESCRIPT_FENCE_a9f7b3__"
const BLOCKED_ENV_PREFIXES = [
  "ANTHROPIC_", "OPENAI_", "OPENROUTER_", "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY",
  "TOGETHER_API_KEY", "PERPLEXITY_API_KEY", "COHERE_API_KEY",
  "FIREWORKS_API_KEY", "XAI_API_KEY", "HELICONE_API_KEY",
  "PARALLEL_API_KEY", "FIRECRAWL_API_KEY", "FIRECRAWL_API_URL",
  "GH_TOKEN", "GITHUB_APP_", "HASS_TOKEN", "HASS_URL",
  "EMAIL_PASSWORD", "EMAIL_IMAP_HOST", "EMAIL_SMTP_HOST",
  "TELEGRAM_", "DISCORD_", "SLACK_", "WHATSAPP_", "SIGNAL_",
  "SUDO_PASSWORD",
]

const LIBS_FILE = path.join(Global.Path.config, "handofai-libs.json")
const ENV_FILE = path.join(Global.Path.config, "handofai-env.json")

function readJsonFile<T>(filepath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, "utf-8")
      return JSON.parse(content) as T
    }
  } catch {}
  return defaultValue
}

function writeJsonFile<T>(filepath: string, value: T): void {
  try {
    const dir = path.dirname(filepath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filepath, JSON.stringify(value, null, 2))
  } catch {}
}

let axiosInstance: any = null

class ExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExecutionError"
  }
}

function getCwd(): string {
  return process.env.OPENCODE_CWD || process.cwd() || os.homedir() || "/"
}

function expandPath(filepath: string): string {
  if (filepath === "~") return os.homedir()
  if (filepath.startsWith("~/") || filepath.startsWith("~\\")) {
    return path.join(os.homedir(), filepath.slice(2))
  }
  if (filepath.startsWith("$HOME/") || filepath.startsWith("$HOME\\")) {
    return path.join(os.homedir(), filepath.slice(6))
  }
  if (filepath.startsWith("$HOME")) {
    return path.join(os.homedir(), filepath.slice(5))
  }
  return filepath
}

function resolvePath(filepath: string, cwd: string): string {
  const expanded = expandPath(filepath)
  if (path.isAbsolute(expanded)) return expanded
  return path.join(cwd, expanded)
}

function sanitizeEnv(baseEnv: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith("_TYPESCRIPT_FORCE_")) {
      sanitized[key.slice("_TYPESCRIPT_FORCE_".length)] = value
      continue
    }
    if (!BLOCKED_ENV_PREFIXES.some(p => key.startsWith(p))) {
      sanitized[key] = value
    }
  }
  return sanitized
}

// Sudo handling
let _cachedSudoPassword = ""

interface SudoResult {
  transformedCommand: string
  sudoStdin: string | null
}

async function transformSudo(command: string, env: Record<string, string>): Promise<SudoResult> {
  if (!/\bsudo\b/.test(command)) {
    return { transformedCommand: command, sudoStdin: null }
  }

  let password: string | null = env.SUDO_PASSWORD || _cachedSudoPassword || null

  if (!password) return { transformedCommand: command, sudoStdin: null }

  _cachedSudoPassword = password
  const transformed = command.replace(/\bsudo\b/g, "sudo -S -p ''")
  return { transformedCommand: transformed, sudoStdin: password + "\n" }
}

// Output truncation
interface TruncateResult {
  content: string
  truncated: boolean
  outputPath?: string
}

function truncateOutput(text: string, maxLines = MAX_OUTPUT_LINES, maxBytes = MAX_OUTPUT_BYTES): TruncateResult {
  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")

  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false }
  }

  const out: string[] = []
  let bytes = 0
  let hitBytes = false

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      hitBytes = true
      break
    }
    out.push(lines[i])
    bytes += size
  }

  const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
  const unit = hitBytes ? "bytes" : "lines"
  const preview = out.join("\n")
  
  const truncationDir = path.join(os.tmpdir(), "handofai-typescript-output")
  fs.mkdirSync(truncationDir, { recursive: true })
  const file = path.join(truncationDir, `output_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`)
  fs.writeFileSync(file, text)

  const hint = `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

  return {
    content: `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`,
    truncated: true,
    outputPath: file,
  }
}

// Process Registry
class ProcessSession {
  readonly id: string
  readonly pid: number
  readonly command: string
  readonly startedAt: Date
  output = ""
  exitCode: number | null = null
  running = true
  private proc: ChildProcess | null = null

  constructor(opts: { id: string; pid: number; command: string; proc?: ChildProcess }) {
    this.id = opts.id
    this.pid = opts.pid
    this.command = opts.command
    this.startedAt = new Date()
    this.proc = opts.proc ?? null
  }

  appendOutput(chunk: string): void {
    this.output += chunk
    if (this.output.length > 200 * 1024) {
      this.output = this.output.slice(-200 * 1024)
    }
  }

  markExited(code: number): void {
    this.exitCode = code
    this.running = false
  }
}

class ProcessRegistry {
  private running = new Map<string, ProcessSession>()
  private finished = new Map<string, ProcessSession>()

  spawn(command: string, opts: { cwd: string; env?: Record<string, string> }): ProcessSession {
    const id = crypto.randomUUID().slice(0, 12)
    const shell = Shell.acceptable()
    const env = { ...process.env, ...opts.env }

    const args = process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
      : ["-lc", command]

    const proc = spawn(shell, args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })

    const session = new ProcessSession({
      id,
      pid: proc.pid!,
      command,
      proc,
    })

    proc.stdout?.on("data", (chunk: Buffer) => session.appendOutput(chunk.toString()))
    proc.stderr?.on("data", (chunk: Buffer) => session.appendOutput(chunk.toString()))

    proc.on("exit", (code) => {
      session.markExited(code ?? 1)
      this.moveToFinished(session)
    })

    this.running.set(id, session)
    return session
  }

  list(): ProcessSession[] {
    return [...this.running.values(), ...this.finished.values()]
  }

  poll(sessionId: string): { output: string; running: boolean; exitCode: number | null } {
    const session = this.running.get(sessionId) || this.finished.get(sessionId)
    if (!session) return { output: "", running: false, exitCode: -1 }
    return { output: session.output, running: session.running, exitCode: session.exitCode }
  }

  async wait(sessionId: string, timeoutMs = 60000): Promise<ProcessSession> {
    const session = this.running.get(sessionId)
    if (!session) {
      const finished = this.finished.get(sessionId)
      if (finished) return finished
      throw new Error(`Process ${sessionId} not found`)
    }
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      const check = () => {
        if (!session.running) { resolve(session); return }
        if (Date.now() >= deadline) { resolve(session); return }
        setTimeout(check, 250)
      }
      check()
    })
  }

  kill(sessionId: string): void {
    const session = this.running.get(sessionId)
    if (!session) return
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(session.pid), "/f", "/t"], { stdio: "ignore" })
      } else {
        process.kill(-session.pid, "SIGTERM")
        setTimeout(() => { try { process.kill(-session.pid, "SIGKILL") } catch {} }, 2000)
      }
    } catch {}
    session.markExited(137)
    this.moveToFinished(session)
  }

  killAll(): void {
    for (const session of this.running.values()) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(session.pid), "/f", "/t"], { stdio: "ignore" })
        } else {
          process.kill(-session.pid, "SIGTERM")
          setTimeout(() => { try { process.kill(-session.pid, "SIGKILL") } catch {} }, 2000)
        }
      } catch {}
      session.markExited(137)
      this.moveToFinished(session)
    }
  }

  private moveToFinished(session: ProcessSession): void {
    this.running.delete(session.id)
    this.finished.set(session.id, session)
  }
}

const processRegistry = new ProcessRegistry()

// Backend types
interface BackendConfig {
  type: "local" | "docker" | "ssh"
  dockerImage?: string
  dockerForwardEnv?: string[]
  dockerVolumes?: string[]
  dockerMountCwd?: boolean
  containerCpu?: number
  containerMemory?: number
  containerDisk?: number
  containerPersistent?: boolean
  sshHost?: string
  sshUser?: string
  sshPort?: number
  sshKey?: string
  sshPersistent?: boolean
}

// Docker backend
class DockerBackend {
  private containerId: string | null = null
  private dockerExe: string

  constructor(private config: BackendConfig) {
    const found = this.findDocker()
    if (!found) throw new Error("Docker executable not found")
    this.dockerExe = found
    this.createContainer()
  }

  private findDocker(): string | null {
    const found = which("docker")
    if (found) return found
    const candidates = [
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
      "/Applications/Docker.app/Contents/Resources/bin/docker",
    ]
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    }
    return null
  }

  private createContainer(): void {
    const image = this.config.dockerImage || "nikolaik/python-nodejs:python3.11-nodejs20"
    const containerName = `handofai-ts-${crypto.randomUUID().slice(0, 8)}`
    
    const result = spawnSync(this.dockerExe, [
      "run", "-d", "--name", containerName, "-w", "/workspace",
      "--cap-drop", "ALL",
      "--cap-add", "DAC_OVERRIDE",
      "--security-opt", "no-new-privileges",
      image, "sleep", "2h",
    ], { timeout: 120_000, encoding: "utf-8" })

    if (result.status !== 0) throw new Error(`Docker container creation failed: ${result.stderr}`)
    this.containerId = result.stdout.trim()
  }

  async execute(command: string, opts: { cwd: string; timeout: number; signal?: AbortSignal }): Promise<{ output: string; exitCode: number }> {
    if (!this.containerId) throw new Error("Container not started")
    
    const cmd = [this.dockerExe, "exec", "-w", "/workspace", this.containerId, "sh", "-c", command]
    
    return new Promise((resolve) => {
      const proc = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString() })
      proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString() })

      const deadline = Date.now() + opts.timeout
      const poll = setInterval(() => {
        if (opts.signal?.aborted) {
          proc.kill("SIGKILL")
          clearInterval(poll)
          resolve({ output: output + "\n\n[User aborted]", exitCode: 130 })
          return
        }
        if (proc.exitCode !== null) {
          clearInterval(poll)
          resolve({ output, exitCode: proc.exitCode })
        }
        if (Date.now() > deadline) {
          proc.kill("SIGKILL")
          clearInterval(poll)
          resolve({ output: output + `\n[Command timed out after ${opts.timeout}ms]`, exitCode: 124 })
        }
      }, 200)

      opts.signal?.addEventListener("abort", () => {
        proc.kill("SIGKILL")
        clearInterval(poll)
        resolve({ output: output + "\n\n[User aborted]", exitCode: 130 })
      }, { once: true })

      proc.on("close", () => {
        clearInterval(poll)
        resolve({ output, exitCode: proc.exitCode ?? 1 })
      })
    })
  }

  async cleanup(): Promise<void> {
    if (!this.containerId) return
    spawn(this.dockerExe, ["stop", "-t", "10", this.containerId], { stdio: "ignore", detached: true }).unref()
    setTimeout(() => {
      spawn(this.dockerExe, ["rm", "-f", this.containerId!], { stdio: "ignore" }).unref()
    }, 3000)
  }
}

// SSH Backend
class SSHBackend {
  private controlSocket: string

  constructor(private config: BackendConfig) {
    const controlDir = path.join(os.tmpdir(), "handofai-ssh")
    fs.mkdirSync(controlDir, { recursive: true })
    this.controlSocket = path.join(controlDir, `${config.sshUser}@${config.sshHost}:${config.sshPort}.sock`)
    this.establishConnection()
  }

  private establishConnection(): void {
    const cmd = this.buildSSHCommand()
    cmd.push("echo 'SSH connection established'")
    const result = spawnSync(cmd[0], cmd.slice(1), { timeout: 15_000, encoding: "utf-8" })
    if (result.status !== 0) {
      throw new Error(`SSH connection failed: ${result.stderr || result.stdout}`)
    }
  }

  private buildSSHCommand(): string[] {
    const cmd = ["ssh"]
    cmd.push("-o", `ControlPath=${this.controlSocket}`)
    cmd.push("-o", "ControlMaster=auto")
    cmd.push("-o", "ControlPersist=300")
    cmd.push("-o", "BatchMode=yes")
    cmd.push("-o", "StrictHostKeyChecking=accept-new")
    if (this.config.sshPort !== 22) cmd.push("-p", String(this.config.sshPort))
    if (this.config.sshKey) cmd.push("-i", this.config.sshKey)
    cmd.push(`${this.config.sshUser}@${this.config.sshHost}`)
    return cmd
  }

  async execute(command: string, opts: { cwd: string; timeout: number; signal?: AbortSignal }): Promise<{ output: string; exitCode: number }> {
    const cmd = this.buildSSHCommand()
    const workDir = opts.cwd || "~"
    cmd.push(`cd ${workDir} && ${command}`)

    return new Promise((resolve) => {
      const proc = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString() })
      proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString() })

      const deadline = Date.now() + opts.timeout
      const poll = setInterval(() => {
        if (opts.signal?.aborted) {
          proc.kill("SIGTERM")
          clearInterval(poll)
          resolve({ output: output + "\n\n[User aborted]", exitCode: 130 })
          return
        }
        if (proc.exitCode !== null) {
          clearInterval(poll)
          resolve({ output, exitCode: proc.exitCode })
        }
        if (Date.now() > deadline) {
          proc.kill("SIGTERM")
          clearInterval(poll)
          resolve({ output: output + `\n[Command timed out after ${opts.timeout}ms]`, exitCode: 124 })
        }
      }, 200)

      opts.signal?.addEventListener("abort", () => {
        proc.kill("SIGTERM")
        clearInterval(poll)
        resolve({ output: output + "\n\n[User aborted]", exitCode: 130 })
      }, { once: true })

      proc.on("close", () => {
        clearInterval(poll)
        resolve({ output, exitCode: proc.exitCode ?? 1 })
      })
    })
  }

  async cleanup(): Promise<void> {
    try {
      spawnSync("ssh", [
        "-o", `ControlPath=${this.controlSocket}`,
        "-O", "exit",
        `${this.config.sshUser}@${this.config.sshHost}`,
      ], { timeout: 5_000 })
    } catch { /* ignore */ }
    try { fs.unlinkSync(this.controlSocket) } catch { /* ignore */ }
  }
}

// PTY Support
interface PtyHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData: ((data: string) => void) | null
  onExit: ((code: number) => void) | null
}

async function createPty(opts: { command: string; cwd: string; env: Record<string, string>; cols?: number; rows?: number; signal?: AbortSignal }): Promise<PtyHandle | null> {
  let ptySpawn: any
  try {
    const mod = await import("bun-pty")
    ptySpawn = mod.spawn
  } catch {
    log.warn("bun-pty not available, PTY mode unavailable")
    return null
  }

  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash"
  const args =
    process.platform === "win32"
      ? ["-Command", opts.command]
      : ["-l", "-c", opts.command]

  const proc = ptySpawn(shell, args, {
    name: "xterm-256color",
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: opts.cwd,
    env: opts.env,
  })

  opts.signal?.addEventListener("abort", () => {
    proc.kill()
  })

  const handle: PtyHandle = {
    write(data: string) { proc.write(data) },
    resize(cols: number, rows: number) { proc.resize(cols, rows) },
    kill() { proc.kill() },
    onData: null,
    onExit: null,
  }

  proc.onData((data: string) => { handle.onData?.(data) })
  proc.onExit(({ exitCode }: { exitCode: number }) => { handle.onExit?.(exitCode) })

  return handle
}

// Main tool definition
export const TypeScriptTool = Tool.define("typescript", {
  description: DESCRIPTION,
  parameters: z.object({
    code: z.string().describe("TypeScript code to execute"),
    description: z.string().optional().describe("Description of what this code does"),
    workdir: z.string().optional().describe("The working directory to execute code in. Defaults to the current terminal directory."),
    timeout: z.number().optional().describe("Timeout in milliseconds for command execution."),
    background: z.boolean().optional().describe("Run in background. Returns session_id for polling/waiting."),
    backend: z.enum(["local", "docker", "ssh"]).optional().describe("Execution backend (local/docker/ssh). Default: local."),
    pty: z.boolean().optional().describe("Use pseudo-terminal for interactive CLI tools."),
    docker_image: z.string().optional().describe("Docker image to use when backend is docker."),
    ssh_host: z.string().optional().describe("SSH host when backend is ssh."),
    ssh_user: z.string().optional().describe("SSH user when backend is ssh."),
    ssh_port: z.number().optional().describe("SSH port when backend is ssh."),
    ssh_key: z.string().optional().describe("SSH private key path when backend is ssh."),
  }),
  async execute(params, ctx) {
    const desc = params.description ?? "TypeScript execution"
    const timeout = params.timeout ?? DEFAULT_TIMEOUT

    if (ctx.abort.aborted) {
      processRegistry.killAll()
      return {
        title: desc,
        metadata: { aborted: true } as Record<string, unknown>,
        output: "User aborted the command",
      }
    }

    let aborted = false
    const abortHandler = () => {
      aborted = true
      processRegistry.killAll()
    }
    ctx.abort.addEventListener("abort", abortHandler, { once: true })

    try {
      const cwd = params.workdir ? resolvePath(params.workdir, getCwd()) : getCwd()
      
      if (ctx.abort.aborted) {
        return {
          title: desc,
          metadata: { aborted: true } as Record<string, unknown>,
          output: "User aborted the command",
        }
      }
      
      // Request permission for external directories (same as Bash tool)
      if (!Instance.containsPath(cwd)) {
        await ctx.ask({
          permission: "external_directory",
          patterns: [path.join(cwd, "*")],
          always: [path.join(cwd, "*")],
          metadata: {},
        })
      }
      
      // Handle backend execution
      if (params.backend && params.backend !== "local") {
        const backendConfig: BackendConfig = {
          type: params.backend,
          dockerImage: params.docker_image,
          sshHost: params.ssh_host,
          sshUser: params.ssh_user,
          sshPort: params.ssh_port || 22,
          sshKey: params.ssh_key,
        }

        if (params.backend === "docker") {
          const backend = new DockerBackend(backendConfig)
          const result = await backend.execute(params.code, { cwd, timeout, signal: ctx.abort })
          const truncated = truncateOutput(result.output)
          return {
            title: desc,
            metadata: { exitCode: result.exitCode, truncated: truncated.truncated, aborted } as Record<string, unknown>,
            output: truncated.content + (aborted ? "\n\n[User aborted]" : ""),
          }
        }

        if (params.backend === "ssh") {
          const backend = new SSHBackend(backendConfig)
          const result = await backend.execute(params.code, { cwd, timeout, signal: ctx.abort })
          const truncated = truncateOutput(result.output)
          return {
            title: desc,
            metadata: { exitCode: result.exitCode, truncated: truncated.truncated, aborted } as Record<string, unknown>,
            output: truncated.content + (aborted ? "\n\n[User aborted]" : ""),
          }
        }
      }

      // Handle PTY mode
      if (params.pty) {
        const ptyHandle = await createPty({
          command: params.code,
          cwd,
          env: sanitizeEnv(process.env as Record<string, string>),
          signal: ctx.abort,
        })
        
        if (!ptyHandle) {
          return {
            title: "PTY Error",
            metadata: {} as Record<string, unknown>,
            output: "PTY mode requested but bun-pty is not available.",
          }
        }

        let output = ""
        ptyHandle.onData = (data) => { output += data }
        
        return new Promise((resolve) => {
          const deadline = Date.now() + timeout
          const interval = setInterval(() => {
            if (ctx.abort.aborted || aborted) {
              ptyHandle.kill()
              clearInterval(interval)
              const truncated = truncateOutput(output)
              resolve({
                title: desc,
                metadata: { truncated: truncated.truncated, aborted: true },
                output: truncated.content + "\n\n[User aborted]",
              } as any)
              return
            }
            if (Date.now() > deadline) {
              ptyHandle.kill()
              clearInterval(interval)
              const truncated = truncateOutput(output)
              resolve({
                title: desc,
                metadata: { truncated: truncated.truncated, timedOut: true },
                output: truncated.content + "\n[Timed out after " + timeout + "ms]",
              } as any)
            }
          }, 1000)

          ptyHandle.onExit = (code: number) => {
            clearInterval(interval)
            const truncated = truncateOutput(output)
            resolve({
              title: desc,
              metadata: { exitCode: code, truncated: truncated.truncated, aborted },
              output: truncated.content + (aborted ? "\n\n[User aborted]" : ""),
            } as any)
          }
        })
      }

      // Handle background execution
      if (params.background) {
        const session = processRegistry.spawn(params.code, { cwd })
        return {
          title: desc,
          metadata: { session_id: session.id, pid: session.pid, background: true } as Record<string, unknown>,
          output: `Background process started with session ID: ${session.id} (PID: ${session.pid})`,
        }
      }

      // Regular execution
      const result = await executeCode(params.code, cwd, ctx, timeout)
      const truncated = truncateOutput(result)

      return {
        title: desc,
        metadata: { truncated: truncated.truncated, aborted } as Record<string, unknown>,
        output: truncated.content + (aborted ? "\n\n[User aborted]" : ""),
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error("execution failed", { error: errMsg })

      return {
        title: "TypeScript Error",
        metadata: { error: errMsg, aborted } as Record<string, unknown>,
        output: `Error: ${errMsg}${aborted ? "\n\n[User aborted]" : ""}`,
      }
    } finally {
      ctx.abort.removeEventListener("abort", abortHandler)
      if (aborted) {
        processRegistry.killAll()
      }
    }
  },
})

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor

interface SandboxContext {
  cwd: string
  ctx: Tool.Context
  timeout?: number
}

async function executeCode(code: string, cwd: string, ctx: Tool.Context, timeout?: number): Promise<string> {
  const logs: string[] = []
  const sandboxCtx: SandboxContext = { cwd, ctx, timeout }

  const sandbox = createSandbox(sandboxCtx, logs)

  try {
    const trimmedCode = code.trim()
    const startsWithBlock = /^\s*\{[^}]*\}/.test(trimmedCode) || /^\s*\{[^:]*\{/.test(trimmedCode)
    const isStatement = /^(const|let|var|if|for|while|function|class|import|export|return|throw)\s/.test(trimmedCode) || 
                        trimmedCode.includes(";") ||
                        startsWithBlock
    
    const wrappedCode = isStatement
      ? trimmedCode
      : `return ${trimmedCode}`

    const sandboxDecl = `const { $, $$, ls, cat, cd, pwd, glob, find, grep, mkdir, rm, touch, cp, mv, ps, kill, write, edit, chmod, which, test, pushd, popd, tools, console, process, __dirname, __filename, platform, arch, isWindows, isMac, isLinux, tempDir, homeDir, read, readLines, stat, exists, copy, move, background, env, pty, docker, ssh, poll, wait, destroy, api, install, require, import: importModule, cleanup } = sandbox;`
    const fnBody = '"use strict";\n' + sandboxDecl + '\ntry { ' + wrappedCode + ' } catch (e) { throw new Error(e.message || String(e)) }'

    const fn = new AsyncFunction("sandbox", fnBody)
    
    let result: any
    const abortPromise = new Promise<void>((_, reject) => {
      ctx.abort.addEventListener("abort", () => {
        processRegistry.killAll()
        reject(new Error("[User aborted]"))
      }, { once: true })
    })
    
    if (timeout && timeout > 0) {
      result = await Promise.race([
        fn(sandbox),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
        ),
        abortPromise,
      ])
    } else {
      result = await Promise.race([
        fn(sandbox),
        abortPromise,
      ])
    }

    const output = result !== undefined ? (
      typeof result === "string" ? result :
      result && typeof result === "object" && result !== null && !(result instanceof Promise) ? JSON.stringify(result, null, 2) :
      result instanceof Promise ? "(Promise returned - use await or $$ for result)" :
      String(result)
    ) : "(no output)"

    if (logs.length > 0) {
      return logs.join("\n") + (output !== "(no output)" ? "\n" + output : "")
    }
    return output
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    if (errMsg === "[User aborted]") {
      return "[User aborted]"
    }
    return `Error: ${errMsg}\n${err instanceof Error && err.stack ? err.stack : ""}`
  } finally {
    // Auto-cleanup installed libraries after execution (success or error)
    try {
      (sandbox as any).cleanup()
    } catch {
      // Ignore cleanup errors
    }
  }
}

function createSandbox(ctx: SandboxContext, logs: string[] = []) {
  let cwd = ctx.cwd
  let installedLibs: string[] = readJsonFile<string[]>(LIBS_FILE, [])

  // Pre-install axios if not already done
  if (!axiosInstance) {
    try {
      const libTempDir = os.tmpdir()
      const axiosDir = path.join(libTempDir, "handofai-libs-axios")
      
      // Check if axios is already installed
      const axiosPath = path.join(axiosDir, "node_modules", "axios")
      if (!fs.existsSync(axiosPath)) {
        // Install axios
        fs.mkdirSync(axiosDir, { recursive: true })
        fs.writeFileSync(path.join(axiosDir, "package.json"), JSON.stringify({ name: "handofai-libs", dependencies: { axios: "*" } }))
        spawnSync("bun", ["install"], { cwd: axiosDir, encoding: "utf-8" })
      }
      
      // Now require axios
      const axios = require(axiosPath)
      axiosInstance = axios.create({
        timeout: 30000,
        validateStatus: () => true,
      })
    } catch (e) {
      // Axios not available, will use fetch fallback
      console.error("Failed to pre-install axios:", e)
    }
  }

  const abortSignal = ctx.ctx.abort

  // Enhanced $ function with full bash-like features
  const $ = async (cmd: string, opts?: { 
    cwd?: string; 
    workdir?: string;
    timeout?: number; 
    sync?: boolean;
    env?: Record<string, string>;
    pty?: boolean;
  }): Promise<{ stdout: string; stderr: string; exitCode: number; pid?: number; sessionId?: string }> => {
    const targetDir = opts?.cwd || opts?.workdir ? resolvePath(opts.cwd || opts.workdir!, cwd) : cwd
    const timeout = opts?.timeout ?? ctx.timeout ?? DEFAULT_TIMEOUT
    const persistedEnvVars = readJsonFile<Record<string, string>>(ENV_FILE, {})
    const shellEnv = { ...persistedEnvVars, ...process.env as Record<string, string>, ...opts?.env }
    const env = sanitizeEnv(shellEnv)
    
    try {
      // Handle PTY mode
      if (opts?.pty) {
        const ptyHandle = await createPty({ command: cmd, cwd: targetDir, env, signal: abortSignal })
        if (!ptyHandle) {
          return { stdout: "", stderr: "PTY not available (bun-pty not installed)", exitCode: 1 }
        }

        let output = ""
        ptyHandle.onData = (data) => { output += data }
        
        return new Promise((resolve) => {
          const deadline = Date.now() + timeout
          const interval = setInterval(() => {
            if (abortSignal.aborted) {
              ptyHandle.kill()
              clearInterval(interval)
              resolve({ stdout: output, stderr: "[User aborted]", exitCode: 130 })
              return
            }
            if (Date.now() > deadline) {
              ptyHandle.kill()
              clearInterval(interval)
              resolve({ stdout: output, stderr: "[Timed out]", exitCode: 124 })
            }
          }, 1000)

          ptyHandle.onExit = (code) => {
            clearInterval(interval)
            resolve({ stdout: output, stderr: abortSignal.aborted ? "[User aborted]" : "", exitCode: code })
          }
        })
      }

      // Handle sudo
      const { transformedCommand, sudoStdin } = await transformSudo(cmd, env)
      
      // If sync is explicitly false, run in background
      if (opts?.sync === false) {
        const session = processRegistry.spawn(transformedCommand, { cwd: targetDir, env })
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          pid: session.pid,
          sessionId: session.id,
        }
      }
      
      const args = process.platform === "win32" 
        ? ["cmd.exe", "/c", transformedCommand]
        : ["/bin/sh", "-c", transformedCommand]
      
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        const proc = spawn(args[0], args.slice(1), {
          cwd: targetDir,
          env,
          stdio: sudoStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        })
        
        let stdout = ""
        let stderr = ""
        
        proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
        proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
        
        if (sudoStdin && proc.stdin) {
          proc.stdin.write(sudoStdin)
          proc.stdin.end()
        }

        const deadline = Date.now() + timeout
        const poll = setInterval(() => {
          if (abortSignal.aborted) {
            proc.kill("SIGKILL")
            clearInterval(poll)
            resolve({ stdout, stderr: stderr + "\n[User aborted]", exitCode: 130 })
            return
          }
          if (proc.exitCode !== null) {
            clearInterval(poll)
            resolve({ stdout, stderr, exitCode: proc.exitCode })
          }
          if (Date.now() > deadline) {
            proc.kill("SIGKILL")
            clearInterval(poll)
            resolve({ stdout, stderr: stderr + `\n[Command timed out after ${timeout}ms]`, exitCode: 124 })
          }
        }, 200)

        abortSignal.addEventListener("abort", () => {
          proc.kill("SIGKILL")
          clearInterval(poll)
          resolve({ stdout, stderr: stderr + "\n[User aborted]", exitCode: 130 })
        }, { once: true })

        proc.on("close", () => {
          clearInterval(poll)
          resolve({ stdout, stderr, exitCode: proc.exitCode ?? 1 })
        })
      })
      
      return result
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return { stdout: "", stderr: `Error executing command: ${errMsg}`, exitCode: 1 }
    }
  }

  // Synchronous version that returns immediately with just output
  const $$ = (cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<string> => {
    return $(cmd, opts).then(r => r.stdout + (r.stderr ? `\n${r.stderr}` : ""))
  }

  // File operations
  const ls = (dirpath?: string): string => {
    const target = resolvePath(dirpath || cwd, cwd)
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true })
      const lines: string[] = []
      for (const entry of entries) {
        try {
          const fullPath = path.join(target, entry.name)
          const stats = fs.statSync(fullPath)
          const isDir = entry.isDirectory()
          const size = stats.size
          const mode = stats.mode.toString(8).slice(-3)
          const mtime = stats.mtime.toISOString().slice(0, 19).replace("T", " ")
          lines.push(`${isDir ? "d" : "-"}${mode.padStart(3, "0")} ${String(size).padStart(10)} ${mtime} ${entry.name}${isDir ? "/" : ""}`)
        } catch {
          // Skip entries that cannot be stat'd (e.g., broken junction points on Windows)
          // Use lstat to get info about the entry itself without following links
          try {
            const fullPath = path.join(target, entry.name)
            const lstats = fs.lstatSync(fullPath)
            const isSymlink = lstats.isSymbolicLink()
            const isDir = entry.isDirectory()
            const size = lstats.size
            const mode = lstats.mode.toString(8).slice(-3)
            const mtime = lstats.mtime.toISOString().slice(0, 19).replace("T", " ")
            lines.push(`${isDir ? "d" : "-"}${mode.padStart(3, "0")} ${String(size).padStart(10)} ${mtime} ${entry.name}${isDir ? "/" : ""}${isSymlink ? "@" : ""}`)
          } catch {
            // Skip entries that cannot be stat'd at all
          }
        }
      }
      return lines.join("\n") || "(empty directory)"
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const cat = (file: string): string => {
    const target = resolvePath(file, cwd)
    try {
      return fs.readFileSync(target, "utf8")
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const cd = (dir: string): string => {
    const target = resolvePath(dir, cwd)
    if (!fs.existsSync(target)) {
      throw new ExecutionError(`Directory not found: ${target}`)
    }
    if (!fs.statSync(target).isDirectory()) {
      throw new ExecutionError(`Not a directory: ${target}`)
    }
    cwd = target
    return target
  }

  const pwd = (): string => cwd

  const glob = (pattern: string, opts?: { limit?: number; exclude?: string[] }): string[] => {
    try {
      const results: string[] = []
      const limit = opts?.limit ?? 1000
      const excludePatterns = opts?.exclude ?? ["node_modules", ".git", "dist", "build", ".next", ".turbo"]
      
      let regexPattern = pattern
      if (pattern.includes("**")) {
        const parts = pattern.split("**")
        const prefix = parts[0] || ""
        const suffix = parts[1]?.replace(/^\/+/, "") || ""
        const prefixRegex = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
        const suffixRegex = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
        if (prefix && suffix) {
          regexPattern = prefixRegex + ".*" + suffixRegex
        } else if (prefix) {
          regexPattern = prefixRegex + ".*"
        } else {
          regexPattern = ".*" + suffixRegex
        }
      } else {
        regexPattern = regexPattern.replace(/\*/g, ".*").replace(/\?/g, ".")
      }
      const regex = new RegExp("^" + regexPattern + "$")
      
      function shouldExclude(dirPath: string): boolean {
        const parts = dirPath.split(path.sep)
        return parts.some(part => excludePatterns.includes(part))
      }
      
      function scan(dir: string) {
        if (results.length >= limit) return
        if (shouldExclude(dir)) return
        
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        
        for (const entry of entries) {
          if (results.length >= limit) break
          const fullPath = path.join(dir, entry.name)
          const relPath = path.relative(cwd, fullPath).replace(/\\/g, "/")
          if (regex.test(relPath) || regex.test(entry.name)) {
            results.push(fullPath)
          }
          if (entry.isDirectory() && !shouldExclude(fullPath)) {
            scan(fullPath)
          }
        }
      }
      
      scan(cwd)
      if (results.length >= limit) {
        return results.slice(0, limit)
      }
      return results
    } catch (e) {
      return []
    }
  }

  const find = (dir: string, opts?: { name?: string; include?: string; type?: "f" | "d" }): string[] => {
    const target = resolvePath(dir, cwd)
    try {
      const results: string[] = []
      
      function scan(scanDir: string) {
        const entries = fs.readdirSync(scanDir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(scanDir, entry.name)
          const isDir = entry.isDirectory()
          
          if (opts?.type === "f" && isDir) {
            scan(fullPath)
            continue
          }
          if (opts?.type === "d" && !isDir) {
            continue
          }
          
          const nameMatch = opts?.name || opts?.include
          if (nameMatch) {
            const regex = new RegExp(nameMatch.replace(/\*/g, ".*"))
            if (!regex.test(entry.name)) {
              if (isDir) scan(fullPath)
              continue
            }
          }
          
          results.push(fullPath)
          if (isDir) scan(fullPath)
        }
      }
      
      scan(target)
      return results
    } catch (e) {
      return []
    }
  }

  const grep = (pattern: string, ...files: string[]): string => {
    if (files.length === 0) {
      return "(no files specified)"
    }
    
    const results: string[] = []
    let patternRegex: RegExp
    try {
      patternRegex = new RegExp(pattern, "i")
    } catch {
      patternRegex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    }
    
    const resolvedFiles: string[] = []
    for (const file of files) {
      if (file.includes("*") || file.includes("?")) {
        const matches = glob(file)
        resolvedFiles.push(...matches)
      } else {
        const target = resolvePath(file, cwd)
        if (fs.existsSync(target)) {
          resolvedFiles.push(target)
        }
      }
    }
    
    for (const file of resolvedFiles) {
      try {
        if (!fs.statSync(file).isFile()) continue
        const content = fs.readFileSync(file, "utf8")
        const lines = content.split("\n")
        for (let i = 0; i < lines.length; i++) {
          if (patternRegex.test(lines[i])) {
            results.push(`${file}:${i + 1}: ${lines[i]}`)
          }
        }
      } catch (e) {
        // Skip files that can't be read
      }
    }
    return results.join("\n") || "(no matches)"
  }

  const mkdir = (dirpath: string): string => {
    const target = resolvePath(dirpath, cwd)
    try {
      fs.mkdirSync(target, { recursive: true })
      return "ok"
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const rm = (filepath: string): string => {
    const target = resolvePath(filepath, cwd)
    try {
      fs.rmSync(target, { recursive: true, force: true })
      return "ok"
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const touch = (file: string): string => {
    const target = resolvePath(file, cwd)
    try {
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, "")
      } else {
        const now = new Date()
        fs.utimesSync(target, now, now)
      }
      return "ok"
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const cp = (src: string, dest: string): string => {
    const srcTarget = resolvePath(src, cwd)
    const destTarget = resolvePath(dest, cwd)
    try {
      fs.mkdirSync(path.dirname(destTarget), { recursive: true })
      fs.cpSync(srcTarget, destTarget, { recursive: true })
      return "ok"
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const mv = (src: string, dest: string): string => {
    const srcTarget = resolvePath(src, cwd)
    const destTarget = resolvePath(dest, cwd)
    try {
      fs.mkdirSync(path.dirname(destTarget), { recursive: true })
      fs.renameSync(srcTarget, destTarget)
      return "ok"
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const ps = (): string => {
    if (process.platform === "win32") {
      try {
        const result = spawnSync("tasklist", [], { encoding: "utf-8" })
        return result.stdout || ""
      } catch (e) {
        return "Error: Could not list processes"
      }
    }
    try {
      const result = spawnSync("ps", ["aux"], { encoding: "utf-8" })
      return result.stdout || ""
    } catch (e) {
      return "Error: Could not list processes"
    }
  }

  const kill = (pid: number | string): string => {
    const numPid = typeof pid === "string" ? parseInt(pid, 10) : pid
    try {
      process.kill(numPid)
      return "ok"
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const write = (file: string, content: string): string => {
    const target = resolvePath(file, cwd)
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
      return "ok"
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const edit = (file: string, oldStr: string, newStr: string): string => {
    const target = resolvePath(file, cwd)
    try {
      const content = fs.readFileSync(target, "utf8")
      if (!content.includes(oldStr)) {
        throw new ExecutionError(`Could not find "${oldStr}" in ${file}`)
      }
      fs.writeFileSync(target, content.replace(oldStr, newStr))
      return "ok"
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const chmod = (mode: string, file: string): string => {
    const target = resolvePath(file, cwd)
    try {
      const modeNum = parseInt(mode, 8)
      fs.chmodSync(target, modeNum)
      return "ok"
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const which = (cmd: string): string | null => {
    const paths = process.env.PATH?.split(process.platform === "win32" ? ";" : ":") || []
    const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""]
    
    for (const dir of paths) {
      for (const ext of extensions) {
        const fullPath = path.join(dir, cmd + ext)
        try {
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            return fullPath
          }
        } catch {
          // Continue
        }
      }
    }
    return null
  }

  const test = (op: string, pathStr: string): boolean => {
    const target = resolvePath(pathStr, cwd)
    try {
      switch (op) {
        case "-e": return fs.existsSync(target)
        case "-f": return fs.existsSync(target) && fs.statSync(target).isFile()
        case "-d": return fs.existsSync(target) && fs.statSync(target).isDirectory()
        default: return false
      }
    } catch {
      return false
    }
  }

  const pushd = (dir: string): string => {
    const target = resolvePath(dir, cwd)
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new ExecutionError(`${dir} is not a directory`)
    }
    cwd = target
    return cwd
  }

  const popd = (): string => {
    const parts = cwd.split(path.sep)
    parts.pop()
    cwd = parts.join(path.sep) || (process.platform === "win32" ? "C:\\" : "/")
    return cwd
  }

  const read = (filepath: string): string => cat(filepath)

  const readLines = (filepath: string, opts?: { offset?: number; limit?: number }): string => {
    try {
      const content = cat(filepath)
      const lines = content.split("\n")
      const offset = opts?.offset ?? 1
      const limit = opts?.limit ?? 2000
      const start = Math.max(0, offset - 1)
      const end = Math.min(start + limit, lines.length)
      return lines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`).join("\n")
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return `Error: ${errMsg}`
    }
  }

  const stat = (filepath: string): { size: number; isDirectory: boolean; isFile: boolean } | null => {
    const target = resolvePath(filepath, cwd)
    try {
      const stats = fs.statSync(target)
      return {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
      }
    } catch {
      return null
    }
  }

  const exists = (filepath: string): boolean => {
    return fs.existsSync(resolvePath(filepath, cwd))
  }

  const copy = (src: string, dest: string): string => cp(src, dest)
  const move = (src: string, dest: string): string => mv(src, dest)

  // Environment access - use an explicit object to avoid sandbox issues
  const persistedEnv: Record<string, string> = readJsonFile<Record<string, string>>(ENV_FILE, {})
  const envObj: Record<string, string> = { ...persistedEnv, ...Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined)
  ) } as Record<string, string>
  const env = {
    get(key: string): string | undefined {
      return envObj[key]
    },
    set(key: string, value: string): void {
      envObj[key] = value
      process.env[key] = value
      persistedEnv[key] = value
      writeJsonFile(ENV_FILE, persistedEnv)
    },
    delete(key: string): void {
      delete envObj[key]
      delete process.env[key]
      delete persistedEnv[key]
      writeJsonFile(ENV_FILE, persistedEnv)
    },
    get all() {
      return { ...envObj }
    },
  }

  // Background process management
  const background = {
    spawn(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): { sessionId: string; pid: number } {
      const targetDir = opts?.cwd ? resolvePath(opts.cwd, cwd) : cwd
      const session = processRegistry.spawn(cmd, { cwd: targetDir, env: opts?.env })
      return { sessionId: session.id, pid: session.pid }
    },
    
    list(): { sessionId: string; pid: number; command: string; running: boolean }[] {
      return processRegistry.list().map(s => ({
        sessionId: s.id,
        pid: s.pid,
        command: s.command,
        running: s.running,
      }))
    },
    
    poll(sessionId: string): { output: string; running: boolean; exitCode: number | null } {
      return processRegistry.poll(sessionId)
    },
    
    async wait(sessionId: string, timeoutMs?: number): Promise<{ output: string; exitCode: number | null }> {
      const session = await processRegistry.wait(sessionId, timeoutMs)
      return { output: session.output, exitCode: session.exitCode }
    },
    
    kill(sessionId: string): void {
      processRegistry.kill(sessionId)
    },
  }

  // Expose background process methods as standalone functions for direct access
  const bgPoll = (sessionId: string) => background.poll(sessionId)
  const bgWait = async (sessionId: string, timeoutMs?: number) => background.wait(sessionId, timeoutMs)
  const bgKill = (sessionId: string) => background.kill(sessionId)

  // Docker helper
  const docker = {
    async run(image: string, command: string, opts?: { 
      volumes?: string[]; 
      env?: Record<string, string>;
      timeout?: number;
    }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      const backend = new DockerBackend({
        type: "docker",
        dockerImage: image,
        dockerForwardEnv: opts?.env ? Object.keys(opts.env) : [],
        dockerVolumes: opts?.volumes || [],
      })
      
      const result = await backend.execute(command, { 
        cwd, 
        timeout: opts?.timeout ?? DEFAULT_TIMEOUT 
      })
      
      await backend.cleanup()
      return { stdout: result.output, stderr: "", exitCode: result.exitCode }
    },
  }

  // SSH helper
  const ssh = {
    async run(host: string, command: string, opts?: {
      user?: string;
      port?: number;
      key?: string;
      timeout?: number;
    }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      const backend = new SSHBackend({
        type: "ssh",
        sshHost: host,
        sshUser: opts?.user || process.env.USER || "root",
        sshPort: opts?.port || 22,
        sshKey: opts?.key,
      })
      
      const result = await backend.execute(command, { 
        cwd, 
        timeout: opts?.timeout ?? DEFAULT_TIMEOUT 
      })
      
      await backend.cleanup()
      return { stdout: result.output, stderr: "", exitCode: result.exitCode }
    },
  }

  // PTY helper
  const pty = {
    async create(command: string, opts?: { cwd?: string; cols?: number; rows?: number }): Promise<PtyHandle | null> {
      return createPty({
        command,
        cwd: opts?.cwd ? resolvePath(opts.cwd, cwd) : cwd,
        env: sanitizeEnv(process.env as Record<string, string>),
        cols: opts?.cols,
        rows: opts?.rows,
      })
    },
  }

  const api = {
      async call(method: string, url: string, opts?: { headers?: Record<string, string>; body?: string; timeout?: number }): Promise<{ status: number; headers: Record<string, string>; body: string; error?: string }> {
        try {
          // Use axios if available, otherwise fall back to fetch
          if (axiosInstance) {
            const response = await axiosInstance({
              method: method.toUpperCase(),
              url,
              headers: { "User-Agent": "handofai-typescript/1.0", ...opts?.headers },
              data: opts?.body,
              timeout: opts?.timeout || 30000,
              validateStatus: () => true, // Accept all status codes
            })
            const headers: Record<string, string> = {}
            if (response.headers) {
              for (const [k, v] of Object.entries(response.headers)) {
                if (typeof v === "string") headers[k] = v
                else if (Array.isArray(v)) headers[k] = v.join(", ")
              }
            }
            return { status: response.status, headers, body: typeof response.data === "string" ? response.data : JSON.stringify(response.data) }
          }
          // Fallback to fetch
          const request = new Request(url, {
            method: method.toUpperCase(),
            headers: { "User-Agent": "handofai-typescript/1.0", ...opts?.headers },
            body: opts?.body,
          })
          const response = await fetch(request)
          const body = await response.text()
          const headers: Record<string, string> = {}
          response.headers.forEach((v: string, k: string) => { headers[k] = v })
          return { status: response.status, headers, body }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          return { status: 0, headers: {}, body: "", error: errMsg }
        }
      },
      async get(url: string, opts?: { headers?: Record<string, string>; timeout?: number }): Promise<string> {
        const result = await this.call("GET", url, opts)
        if (result.error) throw new Error(result.error)
        return result.body
      },
      async post(url: string, opts?: { headers?: Record<string, string>; body?: string; timeout?: number }): Promise<string> {
        const result = await this.call("POST", url, opts)
        if (result.error) throw new Error(result.error)
        return result.body
      },
      async put(url: string, opts?: { headers?: Record<string, string>; body?: string; timeout?: number }): Promise<string> {
        const result = await this.call("PUT", url, opts)
        if (result.error) throw new Error(result.error)
        return result.body
      },
      async delete(url: string, opts?: { headers?: Record<string, string>; timeout?: number }): Promise<string> {
        const result = await this.call("DELETE", url, opts)
        if (result.error) throw new Error(result.error)
        return result.body
      },
      async patch(url: string, opts?: { headers?: Record<string, string>; body?: string; timeout?: number }): Promise<string> {
        const result = await this.call("PATCH", url, opts)
        if (result.error) throw new Error(result.error)
        return result.body
      },
    }

    const tools = {
    filesystem: { read, write, ls, stat, exists, mkdir, rm, touch, cp, mv, copy, move, grep, glob, find, readLines, chmod, test, which },
    shell: { exec: $, $, $$, ls, cat, cd, pwd, glob, find, grep, mkdir, rm, touch, cp, mv, ps, kill, write, edit, chmod, which, test, pushd, popd, read, readLines },
    process: { spawn: background.spawn, list: background.list, poll: background.poll, wait: background.wait, kill: background.kill },
    docker,
    ssh,
    pty,
    env,
    background: { spawn: background.spawn, list: background.list, poll: background.poll, wait: background.wait, kill: background.kill },
    api,
    discover: {
      list(): string[] {
        return [
          "shell globals: $, $$, ls, cat, cd, pwd, glob, find, grep, mkdir, rm, touch, cp, mv, ps, kill, write, edit, chmod, which, test, pushd, popd, poll, wait, destroy, api",
          "tools.filesystem: read, write, ls, stat, exists, mkdir, rm, touch, cp, mv, copy, move, grep, glob, find, readLines, chmod, test, which",
          "tools.shell: exec ($), $$, ls, cat, cd, pwd, glob, find, grep, mkdir, rm, touch, cp, mv, ps, kill, write, edit, chmod, which, test, pushd, popd, read, readLines",
          "tools.process: spawn, list, poll, wait, kill",
          "tools.docker: run(image, command, opts?)",
          "tools.ssh: run(host, command, opts?)",
          "tools.pty: create(command, opts?)",
          "tools.env: get(key), set(key, value), all",
          "tools.background: spawn, list, poll, wait, kill",
          "tools.api: call, get, post, put, delete, patch",
          "tools.discover: list, help",
          "libs: install(packages), import(module), require(module), cleanup()",
          "OpenCode Tools (available via tool calling): bash, browser, websearch, webfetch, read, write, edit, grep, glob, task, memory, vision, skill, todo, codesearch, session_search, lesson, skills_list, skill_manage, moa, cronjob, apply_patch, question",
        ]
      },
      help(tool: string): string {
        const helpMap: Record<string, string> = {
          shell: `Shell globals available directly:
$ (cmd, opts?) - Execute shell command (returns { stdout, stderr, exitCode, pid?, sessionId? })
$$ (cmd, opts?) - Execute shell command (returns output string only)
ls (dir?) - List directory
cat (file) - Read file
cd (dir) - Change directory
pwd - Current directory
glob (pattern) - Find files
find (dir, opts?) - Recursive find
grep (pattern, ...files) - Search in files
mkdir (dir) - Create directory
rm (file) - Delete
touch (file) - Create empty file
cp (src, dest) - Copy
mv (src, dest) - Move
ps - List processes
kill (pid) - Kill process
write (file, content) - Write file
edit (file, old, new) - Edit file`,
          process: `tools.process:
.spawn(cmd, opts?) - Spawn background process
.list() - List all processes
.poll(sessionId) - Check process status
.wait(sessionId, timeout?) - Wait for process to finish
.kill(sessionId) - Kill process`,
          docker: `tools.docker:
.run(image, command, opts?) - Run command in Docker container
opts: { volumes?: string[], env?: Record<string, string>, timeout?: number }`,
          ssh: `tools.ssh:
.run(host, command, opts?) - Run command via SSH
opts: { user?: string, port?: number, key?: string, timeout?: number }`,
          pty: `tools.pty:
.create(command, opts?) - Create PTY for interactive commands
opts: { cwd?: string, cols?: number, rows?: number }
Returns: { write(data), resize(cols, rows), kill(), onData, onExit }`,
          env: `tools.env:
.get(key) - Get environment variable
.set(key, value) - Set environment variable
.delete(key) - Delete environment variable
.all - Get all environment variables`,
          filesystem: `tools.filesystem:
.read(filepath) - Read file
.write(filepath, content) - Write file
.ls(dir?) - List directory
.stat(filepath) - File stats
.exists(filepath) - Check existence
.mkdir(dir) - Create directory
.rm(filepath) - Delete
.touch(file) - Create file
.cp(src, dest) - Copy
.mv(src, dest) - Move
.grep(pattern, ...files) - Search
.glob(pattern, opts?) - Find files (opts: { limit?, exclude? })
.find(dir, opts?) - Recursive find`,
          api: `tools.api:
.call(method, url, opts?) - HTTP request
.get(url, opts?) - GET request
.post(url, opts?) - POST request
.put(url, opts?) - PUT request
.delete(url, opts?) - DELETE request
.patch(url, opts?) - PATCH request`,
          background: `tools.background:
.spawn(cmd, opts?) - Spawn background process
.list() - List all processes
.poll(sessionId) - Check process status
.wait(sessionId, timeout?) - Wait for process to finish
.kill(sessionId) - Kill process`,
          libs: `Dynamic library management (uses bun):
install(packages) - Install npm packages (single string or array)
install("lodash") or install(["lodash", "zod"])
install("package@1.0.0") - with version
Returns: { success, installed[], output }

import(module) - Dynamic ES module import
import("lodash") or import("lodash/random")
Returns the imported module

require(module) - Dynamic CommonJS require
Similar to import but for CommonJS modules

cleanup() - Clean up all installed library directories
Returns: { cleaned: number, output }
Note: Libraries are auto-cleaned after execution completes`,
          browser: `OpenCode browser tool (call via tool system):
Control browser for web automation via NanoBrowser. Send a natural language task and the browser will autonomously navigate, click, type, and extract information.
Parameters: task (natural language description of what to do)
Example: "Find the cheapest wireless mouse on Amazon"`,
          websearch: `OpenCode websearch tool (call via tool system):
Search the web using Exa AI for real-time information. Provides up-to-date information for current events and recent data beyond knowledge cutoff.
Parameters: query, numResults, livecrawl (fallback/preferred), type (auto/fast/deep), contextMaxCharacters
Note: Always include current year (e.g., "AI news 2026") for recent information`,
          webfetch: `OpenCode webfetch tool (call via tool system):
Fetch content from URLs with format conversion. Returns content in requested format (markdown by default).
Parameters: url, format (text/markdown/html), timeout
Note: HTTP URLs automatically upgraded to HTTPS`,
          read: `OpenCode read tool (call via tool system):
Read a file or directory from the local filesystem. Returns up to 2000 lines by default.
Parameters: filePath (absolute), offset (1-indexed line number), limit
Features: Can read images/PDFs as attachments, loop detection after 3 consecutive reads of same file
Note: Use offset/limit for large files, use Grep to find specific content`,
          write: `OpenCode write tool (call via tool system):
Write a file to the local filesystem. Overwrites existing files.
Parameters: filePath (absolute), content
Security: Detects writes to sensitive paths (/etc/, /boot/, docker.sock) and warns before proceeding
Note: MUST use Read tool first if file exists`,
          edit: `OpenCode edit tool (call via tool system):
Performs exact string replacements in files using oldString/newString matching.
Parameters: filePath, oldString, newString, replaceAll
Features: Use replaceAll to change every instance
Note: Edit will FAIL if oldString not found or has multiple matches (provide more context)`,
          grep: `OpenCode grep tool (call via tool system):
Fast content search using regular expressions. Works with any codebase size.
Parameters: pattern (regex), path (directory), include (file pattern like "*.ts")
Features: Secrets automatically redacted, loop detection (warning at 3 repeats, blocked at 4)
Note: Returns file paths and line numbers with matches`,
          glob: `OpenCode glob tool (call via tool system):
Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts".
Parameters: pattern, path (directory)
Returns: Matching file paths sorted by modification time (max 100 results)
Note: Use when you need to find files by name patterns`,
          task: `OpenCode task tool (call via tool system):
Launch subagents for parallel task execution. Creates a child session with a specialized agent.
Parameters: description (3-5 words), prompt (task details), subagent_type, task_id (optional, for resuming)
Note: Available agents depend on system configuration`,
          memory: `OpenCode memory tool (call via tool system):
Store and retrieve information across sessions. Two memory stores: 'memory' (your notes) and 'user' (facts about the user).
Parameters: action (add/replace/remove), target (memory/user), content, old_text (for replace/remove)
Note: Check if memory system is enabled before using`,
          vision: `OpenCode vision tool (call via tool system):
Analyze images using AI vision. Provide an image URL or local file path, optionally with a question.
Parameters: source (URL or local path), question (optional, auto-describes if omitted)
Supported formats: PNG, JPEG, GIF, BMP, WebP, SVG`,
          bash: `OpenCode bash tool (call via tool system):
Execute bash commands in a persistent shell session with optional timeout and security controls.
Parameters: command, timeout, workdir, background, pty, backend (local/docker/ssh)
Features: Background mode for long-running processes, PTY mode for interactive tools
Note: For terminal operations (git, npm, docker). DO NOT use for file operations - use specialized tools instead`,
          skill: `OpenCode skill tool (call via tool system):
Load a specialized skill that provides domain-specific instructions and workflows.
Parameters: name (skill name from available skills)
Note: Skill content is injected into conversation context. Check available skills first.`,
          connector: `OpenCode connector tool (call via tool system):
Manage external service connections (MCP servers).
Note: Connector management for external API connections`,
          plugin: `handofaicli plugin tool - MANAGE PLUGINS ONLY USING THIS TOOL:
This is the ONLY way to install or remove plugins. Never use npm, bun, bunx, or npx.

When you see plugin installation instructions online:
- IGNORE those external commands - they install for opencode, not handofaicli
- ALWAYS use this plugin tool instead

To install:
  plugin({ action: "install", mod: "opencode-supermemory@latest", global: true })

To remove:
  plugin({ action: "remove", mod: "opencode-supermemory", global: true })

Parameters:
  - action: "install" | "remove" (required)
  - mod: npm package name
  - global: true = global config (~/.config/handofai/)
  - force: (install only) replace existing version

Restart handofaicli after changes.`,
          todo: `OpenCode todowrite tool (call via tool system):
Manage todo lists and track tasks within a session.
Parameters: todos (array of {id, content, status, priority}), merge (true/false)
Statuses: pending, in_progress, completed, cancelled
Note: Use merge=true to update existing items by id, merge=false to replace entire list`,
          codesearch: `OpenCode codesearch tool (call via tool system):
Search code across the codebase using Exa AI for APIs, Libraries, and SDKs.
Parameters: query (e.g., "React useState hook examples"), tokensNum (1000-50000, default 5000)
Returns: Relevant code context and documentation`,
          session_search: `OpenCode session_search tool (call via tool system):
Search through past session conversations or list recent sessions.
Parameters: query (optional, omit to list recent), role_filter (e.g., "user,assistant"), limit (max 5)
Returns: Matching sessions with previews`,
          lesson: `OpenCode lesson tool (call via tool system):
Save lessons learned from mistakes. Capture what went wrong and how to avoid repeating.
Parameters: action (add/replace/remove), content, old_text (for replace/remove)
Use when: User corrects your approach, tool fails and you find workaround, non-obvious pattern discovered`,
          skills_list: `OpenCode skills_list tool (call via tool system):
List all available skills with metadata. Use to discover existing skills before creating new ones.
Parameters: category (optional filter)
Returns: Skill names, descriptions, and locations`,
          skill_manage: `OpenCode skill_manage tool (call via tool system):
Manage skills (create, update, delete). Skills are your procedural memory.
Actions: create, edit, patch, delete, write_file, remove_file
Parameters: action, name, content, category, old_string, new_string, file_path, file_content
Security: All skills scanned for malicious patterns`,
          moa: `OpenCode moa (Mixture of Agents) tool (call via tool system):
Use multiple reference models to solve complex problems, then synthesize responses into a single high-quality answer.
Parameters: prompt
Note: Configured via model.json (moa_reference_models, moa_aggregator_model)`,
          cronjob: `OpenCode cronjob tool (call via tool system):
Manage scheduled cron jobs that run prompts or skills at specified intervals.
Actions: create, list, output, update, pause, resume, remove, run
Parameters: action, job_id (for existing jobs), plus action-specific params
Note: Jobs run in fresh sessions with no current-chat context`,
          apply_patch: `OpenCode apply_patch tool (call via tool system):
Apply patches to files with precise changes. Supports add, update, delete, and move operations.
Parameters: patchText (full patch text)
Note: Uses structured patch format for reliable multi-file edits`,
          question: `OpenCode question tool (call via tool system):
Ask clarifying questions to the user when information is missing.
Parameters: questions (array of {question, type, options})
Types: text, number, confirm, select, multiselect
Returns: User answers to continue with the task`,
        }
        return helpMap[tool] ?? `Try: shell, process, docker, ssh, pty, env, filesystem, api, libs, or OpenCode tools: bash, browser, websearch, webfetch, read, write, edit, grep, glob, task, memory, vision, skill, todo, codesearch, session_search, lesson, skills_list, skill_manage, moa, cronjob, apply_patch, question`
      },
    },
  }

  return {
    $,
    $$,
    ls,
    cat,
    cd,
    pwd,
    glob,
    find,
    grep,
    mkdir,
    rm,
    touch,
    cp,
    mv,
    ps,
    kill,
    write,
    edit,
    chmod,
    which,
    test,
    pushd,
    popd,
    read,
    readLines,
    stat,
    exists,
    copy,
    move,
    tools,
    env,
    background,
    poll: background.poll,
    wait: background.wait,
    destroy: background.kill,
    api: api,
    fetch: globalThis.fetch,
    docker,
    ssh,
    pty,
    console: {
      log: (...args: unknown[]) => { logs.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")) },
      error: (...args: unknown[]) => { logs.push(`[error] ${args.join(" ")}`) },
      warn: (...args: unknown[]) => { logs.push(`[warn] ${args.join(" ")}`) },
      info: (...args: unknown[]) => { logs.push(`[info] ${args.join(" ")}`) },
    },
    process: {
      cwd: () => cwd,
      chdir: (dir: string) => { cwd = resolvePath(dir, cwd) },
      exit: () => { throw new ExecutionError("Process.exit() not allowed in sandbox") },
      platform: process.platform,
      arch: process.arch,
      get env() { return { ...process.env } },
    },
    __dirname: cwd,
    __filename: cwd,
    platform: process.platform,
    arch: process.arch,
    isWindows: process.platform === "win32",
    isMac: process.platform === "darwin",
    isLinux: process.platform === "linux",
    tempDir: () => os.tmpdir(),
    homeDir: () => os.homedir(),
    install: async (packages: string | string[], opts?: { saveDev?: boolean; global?: boolean }): Promise<{ success: boolean; installed: string[]; output: string }> => {
      const pkgList = Array.isArray(packages) ? packages : [packages]
      const libTempDir = os.tmpdir()
      const installDir = path.join(libTempDir, `handofai-libs-${Date.now()}`)
      installedLibs.push(installDir)
      writeJsonFile(LIBS_FILE, installedLibs)
      try {
        fs.mkdirSync(installDir, { recursive: true })
        const pkgJson = { name: "handofai-libs", dependencies: {} as Record<string, string> }
        for (const pkg of pkgList) {
          const [name, version] = pkg.includes("@") ? [pkg.split("@")[0], pkg.split("@").slice(1).join("@")] : [pkg, "*"]
          pkgJson.dependencies[name] = version
        }
        fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify(pkgJson, null, 2))
        const installResult = spawnSync("bun", ["install"], { cwd: installDir, encoding: "utf-8" })
        if (installResult.status !== 0) {
          return { success: false, installed: [], output: installResult.stderr || "Install failed" }
        }
        return { success: true, installed: pkgList, output: installResult.stdout }
      } catch (e) {
        return { success: false, installed: [], output: String(e) }
      }
    },
    require: (modulePath: string): unknown => {
      for (const installDir of installedLibs) {
        const nodeModules = path.join(installDir, "node_modules")
        if (!fs.existsSync(nodeModules)) continue
        const fullPath = path.join(nodeModules, modulePath)
        if (fs.existsSync(fullPath)) {
          return require(fullPath)
        }
        const pkgPath = path.join(nodeModules, modulePath, "package.json")
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
          return require(path.join(nodeModules, modulePath, pkg.main || "index.js"))
        }
      }
      return require(modulePath)
    },
    importModule: async (modulePath: string): Promise<unknown> => {
      for (const installDir of installedLibs) {
        const nodeModules = path.join(installDir, "node_modules")
        if (!fs.existsSync(nodeModules)) continue
        const fullPath = path.join(nodeModules, modulePath)
        if (fs.existsSync(fullPath)) {
          return await import(fullPath)
        }
      }
      return await import(modulePath)
    },
    cleanup: (): { cleaned: number; output: string } => {
      let cleaned = 0
      let output = ""
      try {
        for (const dir of installedLibs) {
          try {
            fs.rmSync(dir, { recursive: true, force: true })
            cleaned++
          } catch {
          }
        }
        installedLibs = []
        writeJsonFile(LIBS_FILE, [])
        output = `Cleaned ${cleaned} library directories`
      } catch (e) {
        output = String(e)
      }
      return { cleaned, output }
    },
  }
}
