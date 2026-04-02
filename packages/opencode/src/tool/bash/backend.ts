import { spawn, spawnSync, type ChildProcess } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { Shell } from "@/shell/shell"
import { Log } from "@/util/log"
import { which } from "@/util/which"
import { transformSudo, type SudoResult } from "./sudo"
import { postProcess } from "./redact"
import { createPty, type PtyHandle } from "./pty"

const log = Log.create({ service: "bash-backend" })

export interface ExecOpts {
  cwd: string
  timeout: number
  env: Record<string, string>
  stdin?: string
}

export interface ExecResult {
  output: string
  exitCode: number
  error?: string
}

export interface Backend {
  readonly type: "local" | "docker" | "ssh"
  execute(command: string, opts: ExecOpts): Promise<ExecResult>
  cleanup(): Promise<void>
  touchActivity(): void
}

export type BackendConfig = {
  type: "local" | "docker" | "ssh"
  dockerImage: string
  dockerForwardEnv: string[]
  dockerVolumes: string[]
  dockerMountCwd: boolean
  containerCpu: number
  containerMemory: number
  containerDisk: number
  containerPersistent: boolean
  sshHost: string
  sshUser: string
  sshPort: number
  sshKey: string
  sshPersistent: boolean
  localPersistent: boolean
}

const OUTPUT_FENCE = "__HANDBACK_FENCE_a9f7b3__"

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

const SHELL_NOISE = [
  "bash: cannot set terminal process group",
  "bash: no job control in this shell",
  "no job control in this shell",
  "cannot set terminal process group",
  "tcsetattr: Inappropriate ioctl for device",
  "Restored session:",
  "Saving session...",
  "Last login:",
  "command not found:",
  "Oh My Zsh",
  "compinit:",
]

function wrapWithFence(command: string): string {
  return (
    `printf '${OUTPUT_FENCE}'\n` +
    `${command}\n` +
    `__handb_rc=$?\n` +
    `printf '${OUTPUT_FENCE}'\n` +
    `exit $__handb_rc\n`
  )
}

function extractFencedOutput(raw: string): string {
  const first = raw.indexOf(OUTPUT_FENCE)
  if (first === -1) return cleanShellNoise(raw)
  const start = first + OUTPUT_FENCE.length
  const last = raw.lastIndexOf(OUTPUT_FENCE)
  if (last <= first) return cleanShellNoise(raw.slice(start))
  return raw.slice(start, last)
}

function cleanShellNoise(output: string): string {
  const lines = output.split("\n")
  while (lines.length && SHELL_NOISE.some(n => lines[0].includes(n))) lines.shift()
  let end = lines.length - 1
  while (end >= 0 && (!lines[end] || SHELL_NOISE.some(n => lines[end].includes(n)))) end--
  if (end < 0) return ""
  const result = lines.slice(0, end + 1).join("\n")
  if (output.endsWith("\n") && result && !result.endsWith("\n")) return result + "\n"
  return result
}

export function sanitizeEnv(baseEnv: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith("_HANDBACK_FORCE_")) {
      sanitized[key.slice("_HANDBACK_FORCE_".length)] = value
      continue
    }
    if (!BLOCKED_ENV_PREFIXES.some(p => key.startsWith(p))) {
      sanitized[key] = value
    }
  }
  return sanitized
}

function doLaunch(
  shell: string,
  name: string,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  sudoStdin?: string | null,
): ChildProcess {
  if (process.platform === "win32" && new Set(["powershell", "pwsh"]).has(name)) {
    return spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd, env, stdio: sudoStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      detached: false, windowsHide: true,
    })
  }

  return spawn(command, {
    shell, cwd, env,
    stdio: sudoStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
  })
}

// PersistentShellMixin
class PersistentShellMixin {
  protected _shellProcess: ChildProcess | null = null
  protected _shellPid: number | null = null
  protected _sessionId: string
  protected _persistent: boolean

  constructor(sessionId: string, persistent: boolean) {
    this._sessionId = sessionId
    this._persistent = persistent
  }

  protected get _tempPrefix(): string {
    return path.join(os.tmpdir(), `handofai-persistent-${this._sessionId}`)
  }

  protected async _executePersistent(command: string, cwd: string, timeout: number): Promise<ExecResult> {
    if (!this._shellProcess || this._shellProcess.exitCode !== null) {
      await this._initPersistentShell()
    }

    const ts = Date.now()
    const stdoutFile = `${this._tempPrefix}-stdout-${ts}`
    const stderrFile = `${this._tempPrefix}-stderr-${ts}`
    const exitCodeFile = `${this._tempPrefix}-exitcode-${ts}`
    const doneFile = `${this._tempPrefix}-done-${ts}`

    const escaped = command.replace(/'/g, "'\\''")
    const wrapper = (
      `__cmd='${escaped}'; ` +
      `cd ${cwd} 2>/dev/null; ` +
      `eval "$__cmd" >${stdoutFile} 2>${stderrFile}; ` +
      `echo $? >${exitCodeFile}; ` +
      `touch ${doneFile}\n`
    )

    this._shellProcess!.stdin?.write(wrapper)

    const deadline = Date.now() + timeout
    let interval = 10
    while (Date.now() < deadline) {
      try {
        await fs.promises.access(doneFile)
        break
      } catch { /* not done yet */ }
      await new Promise(r => setTimeout(r, interval))
      interval = Math.min(interval * 2, 250)
    }

    let stdout = "", stderr = "", exitCode = 0
    try { stdout = await fs.promises.readFile(stdoutFile, "utf-8") } catch {}
    try { stderr = await fs.promises.readFile(stderrFile, "utf-8") } catch {}
    try { exitCode = parseInt(await fs.promises.readFile(exitCodeFile, "utf-8"), 10) } catch { exitCode = 1 }

    for (const f of [stdoutFile, stderrFile, exitCodeFile, doneFile]) {
      try { await fs.promises.unlink(f) } catch {}
    }

    const output = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout
    return { output, exitCode }
  }

  protected async _initPersistentShell(): Promise<void> {
    const shell = Shell.acceptable()
    this._shellProcess = spawn(shell, ["-l"], {
      stdio: ["pipe", "pipe", "ignore"],
      detached: process.platform !== "win32",
    })
    this._shellPid = this._shellProcess.pid ?? null
  }

  protected async _killShellChildren(): Promise<void> {
    if (!this._shellPid) return
    try {
      if (process.platform !== "win32") {
        spawn("pkill", ["-P", String(this._shellPid)], { stdio: "ignore" })
      }
    } catch {}
  }

  protected async _cleanupPersistentShell(): Promise<void> {
    if (this._shellProcess) {
      try {
        await this._killShellChildren()
        this._shellProcess.kill("SIGTERM")
        await new Promise<void>(resolve => {
          this._shellProcess!.on("exit", () => resolve())
          setTimeout(resolve, 2000)
        })
      } catch {}
      this._shellProcess = null
    }
    try {
      const files = await fs.promises.readdir(os.tmpdir())
      for (const f of files) {
        if (f.startsWith(`handofai-persistent-${this._sessionId}`)) {
          await fs.promises.unlink(path.join(os.tmpdir(), f))
        }
      }
    } catch {}
  }
}

// LocalBackend
class LocalBackend extends PersistentShellMixin implements Backend {
  readonly type = "local"

  constructor(config: BackendConfig) {
    super(crypto.randomUUID().slice(0, 8), config.localPersistent)
  }

  async execute(command: string, opts: ExecOpts): Promise<ExecResult> {
    const { transformedCommand, sudoStdin } = await transformSudo(command, opts.env)
    const runEnv = sanitizeEnv(opts.env)

    if (this._persistent) {
      return this._executePersistent(transformedCommand, opts.cwd, opts.timeout)
    }

    const fencedCommand = wrapWithFence(transformedCommand)
    const shell = Shell.acceptable()
    const name = Shell.name(shell)
    return this.runOneShot(shell, name, fencedCommand, opts.cwd, runEnv, sudoStdin, opts.timeout)
  }

  private runOneShot(
    shell: string,
    name: string,
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    sudoStdin: string | null,
    timeout: number,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const proc = doLaunch(shell, name, command, cwd, env, sudoStdin)
      let output = ""
      const append = (chunk: Buffer) => { output += chunk.toString() }
      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      if (sudoStdin && proc.stdin) {
        proc.stdin.write(sudoStdin)
        proc.stdin.end()
      }

      const deadline = Date.now() + timeout
      const poll = setInterval(() => {
        if (proc.exitCode !== null) {
          clearInterval(poll)
          resolve({ output: extractFencedOutput(output), exitCode: proc.exitCode })
          return
        }
        if (Date.now() > deadline) {
          proc.kill("SIGKILL")
          clearInterval(poll)
          resolve({ output: extractFencedOutput(output) + `\n[Command timed out after ${timeout}ms]`, exitCode: 124 })
        }
      }, 200)

      proc.on("close", () => {
        clearInterval(poll)
        resolve({ output: extractFencedOutput(output), exitCode: proc.exitCode ?? 1 })
      })

      proc.on("error", (err) => {
        clearInterval(poll)
        resolve({ output: `Local execution error: ${err.message}`, exitCode: 1 })
      })
    })
  }

  async cleanup(): Promise<void> {
    if (this._persistent) await this._cleanupPersistentShell()
  }

  touchActivity(): void {}
}

// DockerBackend
class DockerBackend implements Backend {
  readonly type = "docker"
  private containerId: string | null = null
  private dockerExe: string
  private workspaceDir: string | null = null
  private homeDir: string | null = null
  private _lastActivity = Date.now()

  constructor(private config: BackendConfig) {
    const found = this.findDocker()
    if (!found) throw new Error("Docker executable not found")
    this.dockerExe = found
    this.ensureDockerAvailable()
    this.createContainer()
  }

  async execute(command: string, opts: ExecOpts): Promise<ExecResult> {
    const { transformedCommand, sudoStdin } = await transformSudo(command, opts.env)
    const workDir = opts.cwd || (this.config.dockerMountCwd ? "/workspace" : "/root")
    this._lastActivity = Date.now()

    const cmd = [this.dockerExe, "exec"]
    if (sudoStdin) cmd.push("-i")
    cmd.push("-w", workDir)

    const forwardKeys = new Set(this.config.dockerForwardEnv)
    for (const key of Array.from(forwardKeys).sort()) {
      const value = opts.env[key]
      if (value) cmd.push("-e", `${key}=${value}`)
    }

    if (!this.containerId) throw new Error("Container not started")
    cmd.push(this.containerId, "bash", "-lc", transformedCommand)

    return this.runWithPoll(cmd, opts.timeout, sudoStdin)
  }

  async cleanup(): Promise<void> {
    if (!this.containerId) return
    const cid = this.containerId
    spawn(this.dockerExe, ["stop", "-t", "10", cid], {
      stdio: "ignore", detached: true,
    }).unref()
    if (!this.config.containerPersistent) {
      setTimeout(() => {
        spawn(this.dockerExe, ["rm", "-f", cid], { stdio: "ignore" }).unref()
      }, 3000)
    }
    this.containerId = null
  }

  touchActivity(): void {
    this._lastActivity = Date.now()
  }

  private createContainer(): void {
    const resourceArgs = this.buildResourceArgs()
    const securityArgs = this.buildSecurityArgs()
    const writableArgs = this.buildWritableArgs()
    const volumeArgs = this.buildVolumeArgs()

    const containerName = `handofai-${crypto.randomUUID().slice(0, 8)}`
    const result = spawnSync(this.dockerExe, [
      "run", "-d", "--name", containerName, "-w", "/root",
      ...securityArgs, ...writableArgs, ...resourceArgs, ...volumeArgs,
      this.config.dockerImage, "sleep", "2h",
    ], { timeout: 120_000, encoding: "utf-8" })

    if (result.status !== 0) throw new Error(`Docker container creation failed: ${result.stderr}`)
    this.containerId = result.stdout.trim()
  }

  private buildSecurityArgs(): string[] {
    return [
      "--cap-drop", "ALL",
      "--cap-add", "DAC_OVERRIDE",
      "--cap-add", "CHOWN",
      "--cap-add", "FOWNER",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "256",
      "--tmpfs", "/tmp:rw,nosuid,size=512m",
      "--tmpfs", "/var/tmp:rw,noexec,nosuid,size=256m",
      "--tmpfs", "/run:rw,noexec,nosuid,size=64m",
    ]
  }

  private buildResourceArgs(): string[] {
    const args: string[] = []
    if (this.config.containerCpu > 0) args.push("--cpus", String(this.config.containerCpu))
    if (this.config.containerMemory > 0) args.push("--memory", `${this.config.containerMemory}m`)
    if (this.config.containerDisk > 0 && process.platform !== "darwin" && this.storageOptSupported()) {
      args.push("--storage-opt", `size=${this.config.containerDisk}m`)
    }
    return args
  }

  private buildWritableArgs(): string[] {
    const args: string[] = []
    if (this.config.containerPersistent) {
      const sandboxDir = path.join(os.homedir(), ".config", "handofai", "sandboxes", "docker", crypto.randomUUID().slice(0, 8))
      fs.mkdirSync(path.join(sandboxDir, "home"), { recursive: true })
      fs.mkdirSync(path.join(sandboxDir, "workspace"), { recursive: true })
      this.homeDir = path.join(sandboxDir, "home")
      this.workspaceDir = path.join(sandboxDir, "workspace")
      args.push("-v", `${this.homeDir}:/root`)
      args.push("-v", `${this.workspaceDir}:/workspace`)
    } else {
      args.push("--tmpfs", "/workspace:rw,exec,size=10g")
      args.push("--tmpfs", "/home:rw,exec,size=1g")
      args.push("--tmpfs", "/root:rw,exec,size=1g")
    }
    return args
  }

  private buildVolumeArgs(): string[] {
    const args: string[] = []
    for (const vol of this.config.dockerVolumes) {
      if (vol.includes(":")) args.push("-v", vol)
    }
    return args
  }

  private storageOptSupported(): boolean {
    const result = spawnSync(this.dockerExe, ["info", "--format", "{{.Driver}}"], {
      timeout: 10_000, encoding: "utf-8",
    })
    if (result.status !== 0) return false
    return result.stdout.trim().toLowerCase() === "overlay2"
  }

  private ensureDockerAvailable(): void {
    const result = spawnSync(this.dockerExe, ["version"], {
      timeout: 5_000, encoding: "utf-8",
    })
    if (result.status !== 0) throw new Error("Docker daemon is not responding")
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

  private runWithPoll(
    cmd: string[],
    timeout: number,
    sudoStdin: string | null,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const proc = spawn(cmd[0], cmd.slice(1), {
        stdio: sudoStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      })

      let output = ""
      const append = (chunk: Buffer) => { output += chunk.toString() }
      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      if (sudoStdin && proc.stdin) {
        proc.stdin.write(sudoStdin)
        proc.stdin.end()
      }

      const deadline = Date.now() + timeout
      const poll = setInterval(() => {
        if (proc.exitCode !== null) {
          clearInterval(poll)
          resolve({ output, exitCode: proc.exitCode })
          return
        }
        if (Date.now() > deadline) {
          proc.kill("SIGKILL")
          clearInterval(poll)
          resolve({ output: output + `\n[Command timed out after ${timeout}ms]`, exitCode: 124 })
        }
      }, 200)

      proc.on("close", () => {
        clearInterval(poll)
        resolve({ output, exitCode: proc.exitCode ?? 1 })
      })

      proc.on("error", (err) => {
        clearInterval(poll)
        resolve({ output: `Docker execution error: ${err.message}`, exitCode: 1 })
      })
    })
  }
}

// SSHBackend
class SSHBackend extends PersistentShellMixin implements Backend {
  readonly type = "ssh"
  private controlSocket: string
  private remoteHome: string | null = null
  private sessionId: string
  private _lastActivity = Date.now()

  constructor(private config: BackendConfig) {
    super(crypto.randomUUID().slice(0, 8), config.sshPersistent)
    this.ensureSSHAvailable()
    this.sessionId = crypto.randomUUID().slice(0, 8)
    const controlDir = path.join(os.tmpdir(), "handofai-ssh")
    fs.mkdirSync(controlDir, { recursive: true })
    this.controlSocket = path.join(controlDir, `${config.sshUser}@${config.sshHost}:${config.sshPort}.sock`)
    this.establishConnection()
    this.remoteHome = this.detectRemoteHome()
    this.syncSkillsAndCredentials()
  }

  async execute(command: string, opts: ExecOpts): Promise<ExecResult> {
    this.syncSkillsAndCredentials()
    this._lastActivity = Date.now()

    if (this._persistent) {
      const { transformedCommand } = await transformSudo(command, opts.env)
      return this._executePersistent(transformedCommand, opts.cwd || "~", opts.timeout)
    }

    const { transformedCommand, sudoStdin } = await transformSudo(command, opts.env)
    const workDir = opts.cwd || "~"
    const wrapped = `cd ${workDir} && ${transformedCommand}`

    const cmd = this.buildSSHCommand()
    cmd.push(wrapped)

    return this.runWithPoll(cmd, opts.timeout, sudoStdin ?? undefined)
  }

  async cleanup(): Promise<void> {
    if (this._persistent) await this._cleanupPersistentShell()
    try {
      spawnSync("ssh", [
        "-o", `ControlPath=${this.controlSocket}`,
        "-O", "exit",
        `${this.config.sshUser}@${this.config.sshHost}`,
      ], { timeout: 5_000 })
    } catch { /* ignore */ }
    try { fs.unlinkSync(this.controlSocket) } catch { /* ignore */ }
  }

  touchActivity(): void {
    this._lastActivity = Date.now()
  }

  private buildSSHCommand(extraArgs: string[] = []): string[] {
    const cmd = ["ssh"]
    cmd.push("-o", `ControlPath=${this.controlSocket}`)
    cmd.push("-o", "ControlMaster=auto")
    cmd.push("-o", "ControlPersist=300")
    cmd.push("-o", "BatchMode=yes")
    cmd.push("-o", "StrictHostKeyChecking=accept-new")
    cmd.push("-o", "ConnectTimeout=10")
    if (this.config.sshPort !== 22) cmd.push("-p", String(this.config.sshPort))
    if (this.config.sshKey) cmd.push("-i", this.config.sshKey)
    cmd.push(...extraArgs)
    cmd.push(`${this.config.sshUser}@${this.config.sshHost}`)
    return cmd
  }

  private establishConnection(): void {
    const cmd = this.buildSSHCommand()
    cmd.push("echo 'SSH connection established'")
    const result = spawnSync(cmd[0], cmd.slice(1), { timeout: 15_000, encoding: "utf-8" })
    if (result.status !== 0) {
      throw new Error(`SSH connection failed: ${result.stderr || result.stdout}`)
    }
  }

  private detectRemoteHome(): string {
    try {
      const cmd = this.buildSSHCommand()
      cmd.push("echo $HOME")
      const result = spawnSync(cmd[0], cmd.slice(1), { timeout: 10_000, encoding: "utf-8" })
      if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
    } catch { /* ignore */ }
    return this.config.sshUser === "root" ? "/root" : `/home/${this.config.sshUser}`
  }

  private syncSkillsAndCredentials(): void {
    const rsyncBase = ["rsync", "-az", "--timeout=30", "--safe-links",
      "-e", `ssh -o ControlPath=${this.controlSocket} -o ControlMaster=auto`]
    const dest = `${this.config.sshUser}@${this.config.sshHost}`

    const skillsDir = path.join(os.homedir(), ".config", "handofai", "skills")
    if (fs.existsSync(skillsDir)) {
      const remoteSkillsDir = path.join(this.remoteHome || "/root", ".config", "handofai", "skills")
      spawnSync("ssh", [
        "-o", `ControlPath=${this.controlSocket}`,
        `${this.config.sshUser}@${this.config.sshHost}`,
        `mkdir -p ${remoteSkillsDir}`,
      ], { timeout: 10_000 })
      spawnSync(rsyncBase[0], [...rsyncBase.slice(1), `${skillsDir}/`, `${dest}:${remoteSkillsDir}/`], {
        timeout: 60_000,
      })
    }
  }

  private runWithPoll(
    cmd: string[],
    timeout: number,
    stdinData?: string,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const proc = spawn(cmd[0], cmd.slice(1), {
        stdio: stdinData ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      })

      let output = ""
      const append = (chunk: Buffer) => { output += chunk.toString() }
      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      if (stdinData && proc.stdin) {
        proc.stdin.write(stdinData)
        proc.stdin.end()
      }

      const deadline = Date.now() + timeout
      const poll = setInterval(() => {
        if (proc.exitCode !== null) {
          clearInterval(poll)
          resolve({ output, exitCode: proc.exitCode })
          return
        }
        if (Date.now() > deadline) {
          proc.kill("SIGTERM")
          clearInterval(poll)
          resolve({ output: output + `\n[Command timed out after ${timeout}ms]`, exitCode: 124 })
        }
      }, 200)

      proc.on("close", () => {
        clearInterval(poll)
        resolve({ output, exitCode: proc.exitCode ?? 1 })
      })

      proc.on("error", (err) => {
        clearInterval(poll)
        resolve({ output: `SSH execution error: ${err.message}`, exitCode: 1 })
      })
    })
  }

  private ensureSSHAvailable(): void {
    if (!which("ssh")) {
      throw new Error("SSH is not installed or not in PATH. Install OpenSSH client.")
    }
  }
}

// Factory + cache
const _cache = new Map<string, Backend>()
const _locks = new Map<string, Promise<Backend>>()
const _lastActivity = new Map<string, number>()

export { _cache, _locks, _lastActivity }

export function createBackend(config: BackendConfig): Backend {
  switch (config.type) {
    case "local":   return new LocalBackend(config)
    case "docker":  return new DockerBackend(config)
    case "ssh":     return new SSHBackend(config)
  }
}

export async function getBackend(taskId: string, config: BackendConfig): Promise<Backend> {
  const key = `${taskId}:${config.type}`
  const cached = _cache.get(key)
  if (cached) {
    cached.touchActivity()
    _lastActivity.set(key, Date.now())
    return cached
  }

  let lock = _locks.get(key)
  if (!lock) {
    lock = (async () => {
      const backend = createBackend(config)
      _cache.set(key, backend)
      _lastActivity.set(key, Date.now())
      _locks.delete(key)
      return backend
    })()
    _locks.set(key, lock)
  }
  return lock
}

export async function cleanupBackends(taskId: string) {
  const toRemove: Backend[] = []
  for (const [key, backend] of _cache) {
    if (key.startsWith(`${taskId}:`)) {
      toRemove.push(backend)
      _cache.delete(key)
      _lastActivity.delete(key)
    }
  }
  await Promise.all(toRemove.map(b => b.cleanup()))
}

export async function cleanupAllBackends() {
  const backends = [..._cache.values()]
  _cache.clear()
  _lastActivity.clear()
  _locks.clear()
  await Promise.all(backends.map(b => b.cleanup()))
}
