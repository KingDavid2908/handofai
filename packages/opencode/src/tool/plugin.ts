import z from "zod"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { spawn } from "child_process"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { Tool } from "./tool"
import { BunProc } from "@/bun"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { ConfigPaths } from "@/config/paths"
import { parsePluginSpecifier } from "@/plugin/shared"
import { readPluginManifest, type Target } from "@/plugin/install"

const PLUGIN_HELP = `handofaicli plugin tool - MANAGE PLUGINS ONLY USING THIS TOOL:
This is the ONLY way to install or remove plugins for handofaicli. Never use npm, bun, bunx, or npx.

When you see plugin installation instructions online (e.g., "bunx opencode-supermemory install"):
- IGNORE those external commands - they install for opencode, not handofaicli
- ALWAYS use this plugin tool instead

To install a plugin:
  plugin({ action: "install", mod: "opencode-supermemory@latest", global: true })

To remove a plugin:
  plugin({ action: "remove", mod: "opencode-supermemory", global: true })

Parameters:
  - action: "install" | "remove" (required)
  - mod: npm package name
  - global: true = global config (~/.config/handofai/)
  - force: (install only) replace existing version

Restart handofaicli after changes.`

function pluginSpec(item: unknown): string | undefined {
  if (typeof item === "string") return item
  if (!Array.isArray(item)) return
  if (typeof item[0] !== "string") return
  return item[0]
}

function pluginList(data: unknown): unknown[] | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return
  const item = data as { plugin?: unknown }
  if (!Array.isArray(item.plugin)) return
  return item.plugin
}

function parseTarget(item: unknown): Target | undefined {
  if (item === "server" || item === "tui") return { kind: item }
  if (!Array.isArray(item)) return
  if (item[0] !== "server" && item[0] !== "tui") return
  if (item.length < 2) return { kind: item[0] }
  const opt = item[1]
  if (!opt || typeof opt !== "object" || Array.isArray(opt)) return { kind: item[0] }
  return {
    kind: item[0],
    opts: opt,
  }
}

function parseTargets(raw: unknown): Target[] {
  if (!Array.isArray(raw)) return []
  const map = new Map<string, Target>()
  for (const item of raw) {
    const hit = parseTarget(item)
    if (!hit) continue
    map.set(hit.kind, hit)
  }
  return [...map.values()]
}

function patch(text: string, path: Array<string | number>, value: unknown, insert = false): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: {
        tabSize: 2,
        insertSpaces: true,
      },
      isArrayInsertion: insert,
    }),
  )
}

function patchPluginList(
  text: string,
  list: unknown[] | undefined,
  spec: string,
  next: unknown,
  force = false,
): { mode: "noop" | "add" | "replace"; text: string } {
  const pkg = parsePluginSpecifier(spec).pkg
  const rows = (list ?? []).map((item, i) => ({
    item,
    i,
    spec: pluginSpec(item),
  }))
  const dup = rows.filter((item) => {
    if (!item.spec) return false
    if (item.spec === spec) return true
    if (item.spec.startsWith("file://")) return false
    return parsePluginSpecifier(item.spec).pkg === pkg
  })

  if (!dup.length) {
    if (!list) {
      return {
        mode: "add",
        text: patch(text, ["plugin"], [next]),
      }
    }
    return {
      mode: "add",
      text: patch(text, ["plugin", list.length], next, true),
    }
  }

  if (!force) {
    return {
      mode: "noop",
      text,
    }
  }

  const keep = dup[0]
  if (!keep) {
    return {
      mode: "noop",
      text,
    }
  }

  if (dup.length === 1 && keep.spec === spec) {
    return {
      mode: "noop",
      text,
    }
  }

  let out = text
  if (typeof keep.item === "string") {
    out = patch(out, ["plugin", keep.i], next)
  } else {
    out = patch(out, ["plugin", keep.i, 0], spec)
  }

  return {
    mode: "replace",
    text: out,
  }
}

function patchPluginListRemove(
  text: string,
  list: unknown[] | undefined,
  spec: string,
): { mode: "noop" | "remove"; text: string; removed?: string } {
  const pkg = parsePluginSpecifier(spec).pkg
  const rows = (list ?? []).map((item, i) => ({
    item,
    i,
    spec: pluginSpec(item),
  }))

  const toRemove = rows.filter((row) => {
    if (!row.spec) return false
    if (row.spec === spec) return true
    if (row.spec.startsWith("file://")) return false
    return parsePluginSpecifier(row.spec).pkg === pkg
  })

  if (!toRemove.length) {
    return { mode: "noop", text }
  }

  let out = text
  const removedSpecs: string[] = []

  for (const row of toRemove.sort((a, b) => b.i - a.i)) {
    out = patch(out, ["plugin", row.i], undefined)
    removedSpecs.push(row.spec!)
  }

  return {
    mode: "remove",
    text: out,
    removed: removedSpecs.join(", "),
  }
}

async function removePluginCommands(pkgName: string): Promise<string[]> {
  const removed: string[] = []
  const handofaiCommandDir = path.join(Global.Path.config, "command")
  const shortName = pkgName.replace(/^opencode-/, "").split("@")[0]

  if (!await Filesystem.exists(handofaiCommandDir)) {
    return removed
  }

  try {
    const files = await fs.readdir(handofaiCommandDir, { withFileTypes: true })
    for (const file of files) {
      if (file.name.startsWith(shortName) && file.name.endsWith(".md")) {
        const filePath = path.join(handofaiCommandDir, file.name)
        await fs.unlink(filePath)
        removed.push(file.name.replace(".md", ""))
      }
    }
  } catch {
    // Ignore errors
  }

  return removed
}

async function patchConfigHandofai(spec: string, targets: Target[], global: boolean): Promise<{ ok: true; dir: string; items: Array<{ mode: string; file: string }> } | { ok: false; error: string }> {
  const dir = global ? Global.Path.config : path.join(process.cwd(), ".opencode")
  const cfgName = "handofai"

  const items: Array<{ mode: string; file: string }> = []

  for (const target of targets) {
    try {
      const files = ConfigPaths.fileInDirectory(dir, cfgName)
      let cfg = files[0]
      for (const file of files) {
        if (await Filesystem.exists(file)) {
          cfg = file
          break
        }
      }

      const src = await Filesystem.readText(cfg).catch(() => "{}")
      const text = src.trim() ? src : "{}"

      const errs: ReturnType<typeof parseJsonc> extends (text: string, errors: infer E, opts?: unknown) => unknown ? E : never = []
      const data = parseJsonc(text, errs as any, { allowTrailingComma: true })

      const list = pluginList(data)
      const item = target.opts ? [spec, target.opts] : spec
      const out = patchPluginList(text, list, spec, item, false)

      if (out.mode !== "noop") {
        await Filesystem.write(cfg, out.text)
      }

      items.push({
        mode: out.mode,
        file: cfg,
      })
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  return { ok: true, dir, items }
}

async function setupPluginCommands(pkgName: string, pkgPath: string): Promise<string[]> {
  const commands: string[] = []
  const handofaiCommandDir = path.join(Global.Path.config, "command")
  const shortName = pkgName.replace(/^opencode-/, "").split("@")[0]

  // Ensure destination exists
  await fs.mkdir(handofaiCommandDir, { recursive: true })

  // First, try to run the plugin's CLI installer
  // This creates commands in opencode's directory, which we'll then copy
  const cliPath = path.join(pkgPath, "dist", "cli.js")
  if (await Filesystem.exists(cliPath)) {
    try {
      await runPluginCli(cliPath)
    } catch {
      // CLI failed, but we can still try to copy existing commands
    }
  }

  // Now copy commands from opencode to handofai
  const opencodeCommandDir = path.join(os.homedir(), ".config", "opencode", "command")
  if (await Filesystem.exists(opencodeCommandDir)) {
    try {
      const files = await fs.readdir(opencodeCommandDir, { withFileTypes: true })
      for (const file of files) {
        if (file.name.startsWith(shortName) && file.name.endsWith(".md")) {
          const srcPath = path.join(opencodeCommandDir, file.name)
          const destPath = path.join(handofaiCommandDir, file.name)

          const content = await Filesystem.readText(srcPath)
          const adaptedContent = content
            .replace(/opencode/g, "handofai")
            .replace(/bunx opencode-/g, "handofai ")
            .replace(/npx opencode-/g, "handofai ")

          await Filesystem.write(destPath, adaptedContent)
          commands.push(file.name.replace(".md", ""))
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return commands
}

function runPluginCli(cliPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BunProc.which(), ["run", cliPath, "install", "--no-tui"], {
      stdio: "ignore",
      detached: true,
    })
    proc.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`CLI exited with code ${code}`))
    })
    proc.on("error", reject)
  })
}

async function getConfigFile(global: boolean): Promise<string> {
  const dir = global ? Global.Path.config : path.join(process.cwd(), ".opencode")
  const files = ConfigPaths.fileInDirectory(dir, "handofai")
  for (const file of files) {
    if (await Filesystem.exists(file)) return file
  }
  return files[0]
}

async function readConfig(cfgPath: string): Promise<{ text: string; data: unknown; list: unknown[] | undefined }> {
  const src = await Filesystem.readText(cfgPath).catch(() => "{}")
  const text = src.trim() ? src : "{}"
  const errs: ReturnType<typeof parseJsonc> extends (text: string, errors: infer E, opts?: unknown) => unknown ? E : never = []
  const data = parseJsonc(text, errs as any, { allowTrailingComma: true })
  const list = pluginList(data)
  return { text, data, list }
}

export const PluginTool = Tool.define("plugin", {
  description: PLUGIN_HELP,
  parameters: z.object({
    action: z.enum(["install", "remove"]).describe("Action to perform: install or remove plugin"),
    mod: z.string().describe("npm package name (e.g., opencode-supermemory@latest)"),
    global: z.boolean().optional().default(true).describe("Use global config (~/.config/handofai/)"),
    force: z.boolean().optional().default(false).describe("(install only) Replace existing version"),
  }),
  async execute(params, ctx) {
    const { action, mod, global, force } = params

    await ctx.ask({
      permission: "plugin",
      patterns: ["*"],
      always: ["*"],
      metadata: { action, mod },
    })

    if (action === "remove") {
      return await removePlugin(mod, global)
    }

    return await installPluginTool(mod, global, force)
  },
})

async function removePlugin(mod: string, global: boolean) {
  const cfgPath = await getConfigFile(global)
  const { text, list } = await readConfig(cfgPath)

  const result = patchPluginListRemove(text, list, mod)

  if (result.mode === "noop") {
    return {
      title: "Plugin not found",
      output: `"${mod}" is not installed.`,
      metadata: {},
    }
  }

  // Remove from config
  await Filesystem.write(cfgPath, result.text)

  // Remove commands
  const removedCommands = await removePluginCommands(mod)

  // Remove from node_modules
  const parsed = parsePluginSpecifier(mod)
  const pkgDir = path.join(Global.Path.cache, "node_modules", parsed.pkg)
  let removedFromNodeModules = false
  if (await Filesystem.exists(pkgDir)) {
    await fs.rm(pkgDir, { recursive: true, force: true })
    removedFromNodeModules = true
  }

  // Remove from dependencies cache
  const pkgjsonPath = path.join(Global.Path.cache, "package.json")
  try {
    const depsFile = await Filesystem.readJson<{ dependencies?: Record<string, string> }>(pkgjsonPath)
    if (depsFile.dependencies && depsFile.dependencies[parsed.pkg]) {
      delete depsFile.dependencies[parsed.pkg]
      await Filesystem.writeJson(pkgjsonPath, depsFile)
    }
  } catch {
    // Ignore errors reading/writing deps file
  }

  const lines: string[] = []
  lines.push(`Removed ${result.removed}`)
  lines.push(`Updated ${cfgPath}`)
  if (removedCommands.length > 0) {
    lines.push(`Removed commands: ${removedCommands.join(", ")}`)
  }
  if (removedFromNodeModules) {
    lines.push(`Cleaned up: ${pkgDir}`)
  }
  lines.push(``)
  lines.push("Restart handofaicli to complete removal.")

  return {
    title: `Plugin removed`,
    output: lines.join("\n"),
    metadata: {},
  }
}

async function installPluginTool(mod: string, global: boolean, force: boolean) {
  const parsed = parsePluginSpecifier(mod)

  let installResult: string
  try {
    installResult = await BunProc.install(parsed.pkg, parsed.version)
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e)
    return {
      title: "Plugin install failed",
      output: `Failed to download "${mod}": ${errMsg}\n\nThe package may not exist on npm.`,
      metadata: {},
    }
  }

  const pkgJsonPath = path.join(installResult, "package.json")
  if (!await Filesystem.exists(pkgJsonPath)) {
    return {
      title: "Plugin install failed",
      output: `Package "${mod}" was not found on npm or failed to install.`,
      metadata: {},
    }
  }

  let targets: Target[] = []
  try {
    const manifest = await readPluginManifest(installResult)
    if (manifest.ok) targets = manifest.targets
  } catch {}

  if (!targets.length) targets = [{ kind: "tui" }]

  const cfgPath = await getConfigFile(global)
  const { text, list } = await readConfig(cfgPath)

  const items: Array<{ mode: string; file: string }> = []
  for (const target of targets) {
    const item = target.opts ? [mod, target.opts] : mod
    const out = patchPluginList(text, list, mod, item, force)

    if (out.mode !== "noop") {
      await Filesystem.write(cfgPath, out.text)
    }

    items.push({ mode: out.mode, file: cfgPath })
  }

  const copiedCommands = await setupPluginCommands(parsed.pkg, installResult)

  const lines: string[] = []
  lines.push(`Installed ${mod}`)
  lines.push(`Location: ${installResult}`)
  lines.push(`Targets: ${targets.map(t => t.kind).join(", ")}`)
  for (const item of items) {
    lines.push(item.mode === "noop" ? `Already in ${item.file}` : `Added to ${item.file}`)
  }
  if (copiedCommands.length > 0) {
    lines.push(`Commands: /${copiedCommands.join(", /")}`)
  }
  lines.push(``)
  lines.push("Restart handofaicli to activate.")

  return {
    title: `Plugin ${mod} installed`,
    output: lines.join("\n"),
    metadata: {},
  }
}
