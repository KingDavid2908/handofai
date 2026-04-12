import shell from "shelljs"
import path from "path"
import os from "os"

export interface ShellOptions {
  cwd?: string
  timeout?: number
  env?: Record<string, string>
}

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

export const $ = (cmd: string, opts?: ShellOptions): Promise<ShellResult> => {
  return new Promise((resolve) => {
    const cwd = opts?.cwd ?? process.cwd()
    const result = shell.exec(cmd, {
      cwd,
      silent: false,
      timeout: opts?.timeout,
      env: opts?.env ? { ...process.env, ...opts?.env } : undefined,
    })

    resolve({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code ?? -1,
    })
  })
}

export const ls = (dir?: string): string => {
  const target = dir ?? process.cwd()
  const result = shell.ls("-la", target)
  return result.stdout
}

export const cat = (file: string): string => {
  return shell.cat(file).stdout
}

export const cd = (dir: string): string => {
  const result = shell.cd(dir)
  if (result.code !== 0) {
    throw new Error(`cd failed: ${result.stderr}`)
  }
  return shell.pwd().toString()
}

export const pwd = (): string => {
  return shell.pwd().toString()
}

export const glob = (pattern: string): string[] => {
  return shell.find(pattern)
}

export const find = (dir: string, opts?: { name?: string; type?: "f" | "d" }): string[] => {
  const target = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
  let results = shell.find(target)

  if (opts?.name) {
    const regex = new RegExp(opts.name.replace(/\*/g, ".*"))
    results = results.filter((f) => regex.test(path.basename(f)))
  }

  if (opts?.type === "f") {
    results = results.filter((f) => shell.test("-f", f))
  } else if (opts?.type === "d") {
    results = results.filter((f) => shell.test("-d", f))
  }

  return results
}

export const grep = (pattern: string, ...files: string[]): string => {
  const result = shell.grep(pattern, ...files)
  return result.stdout || "(no matches)"
}

export const mkdir = (dir: string, opts?: { parents?: boolean }): string => {
  const flags = opts?.parents ? "-p" : ""
  const result = shell.mkdir(flags, dir)
  if (result.code !== 0) {
    throw new Error(`mkdir failed: ${result.stderr}`)
  }
  return "ok"
}

export const rm = (file: string, opts?: { recursive?: boolean; force?: boolean }): string => {
  let flags = ""
  if (opts?.recursive) flags += " -rf"
  else if (opts?.force) flags += " -f"

  const cmd = `rm${flags} ${file}`
  const result = shell.exec(cmd)
  if (result.code !== 0) {
    throw new Error(`rm failed: ${result.stderr}`)
  }
  return "ok"
}

export const cp = (src: string, dest: string, opts?: { recursive?: boolean }): string => {
  const flags = opts?.recursive ? "-R" : ""
  const result = shell.cp(flags, src, dest)
  if (result.code !== 0) {
    throw new Error(`cp failed: ${result.stderr}`)
  }
  return "ok"
}

export const mv = (src: string, dest: string): string => {
  const result = shell.mv(src, dest)
  if (result.code !== 0) {
    throw new Error(`mv failed: ${result.stderr}`)
  }
  return "ok"
}

export const touch = (file: string): string => {
  const result = shell.touch(file)
  if (result.code !== 0) {
    throw new Error(`touch failed: ${result.stderr}`)
  }
  return "ok"
}

export const chmod = (mode: string, file: string): string => {
  const result = shell.chmod(mode, file)
  if (result.code !== 0) {
    throw new Error(`chmod failed: ${result.stderr}`)
  }
  return "ok"
}

export const env = (key?: string): string | Record<string, string> | undefined => {
  if (key) return process.env[key]
  return process.env
}

export const setEnv = (key: string, value: string): void => {
  process.env[key] = value
}

export const ps = (): string => {
  if (process.platform === "win32") {
    return shell.exec("tasklist", { silent: true }).stdout
  }
  return shell.exec("ps aux", { silent: true }).stdout
}

export const kill = (pid: number | string): string => {
  const numPid = typeof pid === "string" ? parseInt(pid, 10) : pid
  if (process.platform === "win32") {
    const result = shell.exec(`taskkill /PID ${numPid} /F`, { silent: true })
    if (result.code !== 0) {
      throw new Error(`kill failed: ${result.stderr}`)
    }
  } else {
    const result = shell.exec(`kill -9 ${numPid}`, { silent: true })
    if (result.code !== 0) {
      throw new Error(`kill failed: ${result.stderr}`)
    }
  }
  return "ok"
}

export const which = (cmd: string): string | null => {
  const result = shell.which(cmd)
  return result ? result.toString() : null
}

export const echo = (msg: string): string => {
  return shell.echo(msg).toString()
}

export const head = (file: string, lines?: number): string => {
  const n = lines ?? 10
  return shell.head(`-n ${n}`, file).stdout
}

export const tail = (file: string, lines?: number): string => {
  const n = lines ?? 10
  return shell.tail(`-n ${n}`, file).stdout
}

export const sort = (file: string): string => {
  return shell.sort(file).stdout
}

export const uniq = (file: string): string => {
  return shell.uniq(file).stdout
}

export const wc = (file: string): string => {
  return shell.exec(`wc ${file}`, { silent: true }).stdout
}

export const du = (path: string): string => {
  return shell.exec(`du -h ${path}`, { silent: true }).stdout
}

export const df = (): string => {
  return shell.exec("df -h", { silent: true }).stdout
}

export const free = (): string => {
  if (process.platform === "win32") {
    return shell.exec("wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /Value", { silent: true }).stdout
  }
  return shell.exec("free -h", { silent: true }).stdout
}

export const whoami = (): string => {
  return shell.exec("whoami", { silent: true }).stdout.trim()
}

export const date = (): string => {
  return shell.exec("date", { silent: true }).stdout.trim()
}

export const expandPath = (p: string): string => {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2))
  if (p.startsWith("$HOME/")) return path.join(os.homedir(), p.slice(6))
  return p
}

export const normalizePath = (p: string, cwd: string): string => {
  const expanded = expandPath(p)
  if (path.isAbsolute(expanded)) return expanded
  return path.join(cwd, expanded)
}

export const test = (op: "e" | "f" | "d" | "r" | "w" | "x", path: string): boolean => {
  return shell.test(op, path)
}

export const pushd = (dir: string): string => {
  const result = shell.pushd(dir)
  if (result.code !== 0) {
    throw new Error(`pushd failed: ${result.stderr}`)
  }
  return shell.pwd().toString()
}

export const popd = (): string => {
  const result = shell.popd()
  if (result.code !== 0) {
    throw new Error(`popd failed: ${result.stderr}`)
  }
  return shell.pwd().toString()
}

export const tempDir = (): string => os.tmpdir()
export const homeDir = (): string => os.homedir()
export const platform = process.platform
export const arch = process.arch
export const isWindows = process.platform === "win32"
export const isMac = process.platform === "darwin"
export const isLinux = process.platform === "linux"