import os from "os"
import path from "path"

export interface LsEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
  size: number
}

export interface ShellGlobResult {
  files: string[]
  dirs: string[]
}

export function createGlobResult(entries: string[]): ShellGlobResult {
  return {
    files: entries.filter((e) => !e.endsWith("/")),
    dirs: entries.filter((e) => e.endsWith("/")).map((e) => e.slice(0, -1)),
  }
}

export interface GrepMatch {
  file: string
  line: number
  content: string
  column?: number
}

export function formatGrepOutput(matches: GrepMatch[]): string {
  return matches.map((m) => `${m.file}:${m.line}:${m.column ? m.column + ":" : ""} ${m.content}`).join("\n")
}

export function parseFlags(args: string[]): { flags: string[]; rest: string[] } {
  const flags: string[] = []
  const rest: string[] = []

  for (const arg of args) {
    if (arg.startsWith("-") && arg.length > 1) {
      flags.push(arg)
    } else {
      rest.push(arg)
    }
  }

  return { flags, rest }
}

export function buildCommand(args: string[], isWindows: boolean): string {
  if (isWindows) {
    return args.map((a) => a.includes(" ") ? `"${a}"` : a).join(" ")
  }
  return args.join(" ")
}

export function normalizePath(p: string, cwd: string): string {
  if (p.startsWith("/") || (p.length > 2 && p[1] === ":")) {
    return p
  }
  return path.join(cwd, p)
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  if (p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2))
  return p
}

export const SHELL_ALIASES: Record<string, string | string[]> = process.platform === "win32" ? {
  ls: ["Get-ChildItem", "-Force"],
  cat: "Get-Content",
  pwd: "Get-Location",
  rm: "Remove-Item",
  cp: "Copy-Item",
  mv: "Move-Item",
  mkdir: ["New-Item", "-ItemType", "Directory"],
  touch: ["New-Item", "-ItemType", "File"],
  grep: "Select-String",
  find: ["Get-ChildItem", "-Recurse"],
} : {}

export function resolveAlias(cmd: string): string | string[] | undefined {
  return SHELL_ALIASES[cmd]
}

export function buildWindowsCommand(unixCmd: string, args: string[]): string {
  const alias = resolveAlias(unixCmd)
  if (!alias) return unixCmd

  if (Array.isArray(alias)) {
    return [...alias, ...args].join(" ")
  }

  if (args.length === 0) return alias

  return `${alias} ${args.join(" ")}`
}