import { spawn, type ChildProcess } from "child_process"
import { Writable } from "stream"
import fs from "fs"
import path from "path"
import os from "os"
import { Shell } from "@/shell/shell"
import { Log } from "@/util/log"

const log = Log.create({ service: "process-registry" })

const MAX_PROCESSES = 64
const FINISHED_TTL_MS = 30 * 60 * 1000
const OUTPUT_BUFFER_MAX = 200 * 1024

export class ProcessSession {
  readonly id: string
  readonly pid: number
  readonly taskId: string
  readonly sessionKey: string
  readonly startedAt: Date
  output = ""
  exitCode: number | null = null
  running = true
  pty: boolean | null = null
  watcherInterval: number | null = null
  watcherPlatform = ""
  watcherChatId = ""
  watcherThreadId = ""
  private proc: ChildProcess | null = null

  getStdin(): Writable | null {
    return this.proc?.stdin ?? null
  }

  constructor(opts: { id: string; pid: number; taskId: string; sessionKey: string; proc?: ChildProcess }) {
    this.id = opts.id
    this.pid = opts.pid
    this.taskId = opts.taskId
    this.sessionKey = opts.sessionKey
    this.startedAt = new Date()
    this.proc = opts.proc ?? null
  }

  appendOutput(chunk: string): void {
    this.output += chunk
    if (this.output.length > OUTPUT_BUFFER_MAX) {
      this.output = this.output.slice(-OUTPUT_BUFFER_MAX)
    }
  }

  markExited(code: number): void {
    this.exitCode = code
    this.running = false
  }
}

export class ProcessRegistry {
  private running = new Map<string, ProcessSession>()
  private finished = new Map<string, ProcessSession>()
  private checkpointPath: string
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  pendingWatchers: {
    sessionId: string
    checkInterval: number
    sessionKey: string
    platform: string
    chatId: string
    threadId: string
  }[] = []

  constructor() {
    this.checkpointPath = path.join(os.tmpdir(), "handofai-processes.json")
    this.loadCheckpoint()
    this.startPruneTimer()
    this.recoverDetached()
  }

  spawnLocal(opts: {
    command: string
    cwd: string
    taskId: string
    sessionKey: string
    envVars?: Record<string, string>
    usePty?: boolean
  }): ProcessSession {
    const id = crypto.randomUUID().slice(0, 12)
    const shell = Shell.acceptable()
    const env = { ...process.env, ...opts.envVars }

    const args = process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", opts.command]
      : ["-lc", opts.command]

    const proc = spawn(shell, args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })

    const session = new ProcessSession({
      id,
      pid: proc.pid!,
      taskId: opts.taskId,
      sessionKey: opts.sessionKey,
      proc,
    })
    session.pty = opts.usePty ?? false

    proc.stdout?.on("data", (chunk: Buffer) => {
      session.appendOutput(chunk.toString())
    })
    proc.stderr?.on("data", (chunk: Buffer) => {
      session.appendOutput(chunk.toString())
    })

    proc.on("exit", (code) => {
      session.markExited(code ?? 1)
      this.moveToFinished(session)
      this.saveCheckpoint()
    })

    this.running.set(id, session)
    this.saveCheckpoint()
    return session
  }

  spawnViaEnv(env: { execute: (cmd: string, opts: any) => Promise<any> }, opts: {
    command: string
    cwd: string
    taskId: string
    sessionKey: string
  }): ProcessSession {
    const id = crypto.randomUUID().slice(0, 12)
    const logFile = path.join(os.tmpdir(), `handofai-bg-${id}.log`)
    const bgCommand = `nohup ${opts.command} > ${logFile} 2>&1 & echo $!`

    env.execute(bgCommand, { cwd: opts.cwd, timeout: 10_000 }).then((result: any) => {
      const pid = parseInt(result.output?.trim() || "0", 10)
      const session = new ProcessSession({
        id, pid, taskId: opts.taskId, sessionKey: opts.sessionKey,
      })
      this.running.set(id, session)

      const pollInterval = setInterval(async () => {
        if (!session.running) { clearInterval(pollInterval); return }
        try {
          const content = fs.readFileSync(logFile, "utf-8")
          session.output = content.slice(-OUTPUT_BUFFER_MAX)
        } catch { /* file may not exist yet */ }
        try { process.kill(pid, 0) } catch {
          session.markExited(0)
          this.moveToFinished(session)
          clearInterval(pollInterval)
          this.saveCheckpoint()
        }
      }, 2000)
    })

    return new ProcessSession({ id, pid: 0, taskId: opts.taskId, sessionKey: opts.sessionKey })
  }

  list(taskId: string): ProcessSession[] {
    return [...this.running.values(), ...this.finished.values()]
      .filter(s => s.taskId === taskId)
  }

  hasActiveProcesses(taskId: string): boolean {
    for (const session of this.running.values()) {
      if (session.taskId === taskId && session.running) return true
    }
    return false
  }

  poll(sessionId: string): { output: string; running: boolean; exitCode: number | null } {
    const session = this.running.get(sessionId) || this.finished.get(sessionId)
    if (!session) return { output: "", running: false, exitCode: -1 }
    return { output: session.output, running: session.running, exitCode: session.exitCode }
  }

  log(sessionId: string, tail?: number): string {
    const session = this.running.get(sessionId) || this.finished.get(sessionId)
    if (!session) return ""
    if (!tail) return session.output
    return session.output.split("\n").slice(-tail).join("\n")
  }

  async wait(sessionId: string, timeoutMs: number = 60000): Promise<ProcessSession> {
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
        setTimeout(() => { try { process.kill(-session.pid, "SIGKILL") } catch { /* already dead */ } }, 2000)
      }
    } catch { /* already dead */ }
    session.markExited(137)
    this.moveToFinished(session)
    this.saveCheckpoint()
  }

  write(sessionId: string, data: string): void {
    const session = this.running.get(sessionId)
    const stdin = session?.getStdin()
    if (!stdin) return
    stdin.write(data)
  }

  submit(sessionId: string, data: string): void {
    this.write(sessionId, data + "\n")
  }

  private moveToFinished(session: ProcessSession): void {
    this.running.delete(session.id)
    this.finished.set(session.id, session)
  }

  private startPruneTimer(): void {
    this.pruneTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, session] of this.finished) {
        if (now - session.startedAt.getTime() > FINISHED_TTL_MS) this.finished.delete(id)
      }
      if (this.finished.size > MAX_PROCESSES / 2) {
        const sorted = [...this.finished.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        for (let i = 0; i < sorted.length - MAX_PROCESSES / 2; i++) this.finished.delete(sorted[i].id)
      }
      this.saveCheckpoint()
    }, 60_000)
  }

  private saveCheckpoint(): void {
    try {
      const data = {
        running: [...this.running.values()].map(s => ({
          id: s.id, pid: s.pid, taskId: s.taskId, sessionKey: s.sessionKey,
          startedAt: s.startedAt.toISOString(),
        })),
      }
      fs.writeFileSync(this.checkpointPath, JSON.stringify(data, null, 2))
    } catch { /* ignore */ }
  }

  private loadCheckpoint(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.checkpointPath, "utf-8"))
      for (const s of data.running || []) {
        const session = new ProcessSession(s)
        session.running = true
        this.running.set(s.id, session)
      }
    } catch { /* no checkpoint or malformed */ }
  }

  private recoverDetached(): void {
    for (const [id, session] of this.running) {
      try { process.kill(session.pid, 0) } catch {
        session.markExited(-1)
        this.moveToFinished(session)
      }
    }
  }

  dispose(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
  }
}

let _instance: ProcessRegistry | null = null
export function getProcessRegistry(): ProcessRegistry {
  if (!_instance) _instance = new ProcessRegistry()
  return _instance
}
