import { Log } from "@/util/log"

const log = Log.create({ service: "pty" })

export interface PtyHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData: ((data: string) => void) | null
  onExit: ((code: number) => void) | null
}

export function createPty(opts: {
  command: string
  cwd: string
  env: Record<string, string>
  cols?: number
  rows?: number
}): PtyHandle | null {
  let pty: any
  try {
    pty = require("node-pty")
  } catch {
    log.warn("node-pty not installed, PTY mode unavailable")
    return null
  }

  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash"
  const args = process.platform === "win32" ? [] : ["-l", "-c", opts.command]

  const proc = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: opts.cwd,
    env: opts.env,
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
