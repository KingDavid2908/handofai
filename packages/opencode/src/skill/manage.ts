import path from "path"
import fs from "fs/promises"
import { scanSkill, shouldAllowInstall, formatScanReport } from "@/tool/skills-guard"
import type { ScanResult } from "@/tool/skills-guard"
import { Global } from "@/global"
import { SyncEvent } from "@/sync"

const SKILLS_DIR = path.join(Global.Path.config, "skills")
const ALLOWED_SUBDIRS = ["references", "templates", "scripts", "assets"]
const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export interface ManageResult {
  success: boolean
  message?: string
  error?: string
  path?: string
  hint?: string
  scanReport?: string
  availableFiles?: string[]
  matchCount?: number
  filePreview?: string
}

function escapeRegex(str: string): RegExp {
  return new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
}

function validateName(name: string): string | null {
  if (!name) return "Skill name is required."
  if (name.length > MAX_NAME_LENGTH) return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`
  if (!NAME_PATTERN.test(name)) return "Invalid skill name. Use lowercase letters, numbers, hyphens, dots, underscores. Must start with letter or digit."
  return null
}

function validateCategory(category: string | undefined): string | null {
  if (!category) return null
  if (category.length > MAX_NAME_LENGTH) return `Category exceeds ${MAX_NAME_LENGTH} characters.`
  if (!NAME_PATTERN.test(category)) return "Invalid category name."
  return null
}

function validateFrontmatter(content: string): string | null {
  if (!content.trim()) return "Content cannot be empty."
  if (!content.startsWith("---")) return "SKILL.md must start with YAML frontmatter (---)."
  if (!/\n---\s*\n/.test(content.slice(3))) return "Frontmatter is not closed."

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return "Invalid frontmatter."

  const yamlContent = match[1]

  const yamlLines: Record<string, string> = {}
  for (const line of yamlContent.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const colonIdx = trimmed.indexOf(":")
    if (colonIdx <= 0) continue
    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()
    yamlLines[key] = value
  }

  if (!yamlLines.name) return "Frontmatter must include 'name' field."
  if (!yamlLines.description) return "Frontmatter must include 'description' field."
  if (yamlLines.description.length > MAX_DESCRIPTION_LENGTH) return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`

  const bodyStart = content.indexOf("\n---\n", 3)
  if (bodyStart < 0) return "Frontmatter is not closed."
  const body = content.slice(bodyStart + 5).trim()
  if (!body) return "SKILL.md must have content after the frontmatter."

  return null
}

function validateFilePath(filePath: string): string | null {
  if (!filePath) return "file_path is required."
  if (filePath.includes("..")) return "Path traversal ('..') is not allowed."

  const firstDir = filePath.split("/")[0]
  if (!ALLOWED_SUBDIRS.includes(firstDir)) return `File must be under: ${ALLOWED_SUBDIRS.join(", ")}. Got: '${firstDir}'`

  if (filePath.split("/").length < 2) return `Provide a file path, not just a directory. Example: 'references/example.md'`

  return null
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp.${Date.now()}`)
  try {
    await fs.writeFile(tempPath, content, "utf-8")
    await fs.rename(tempPath, filePath)
  } catch (e) {
    try { await fs.unlink(tempPath) } catch {}
    throw e
  }
}

async function findSkill(name: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(SKILLS_DIR, { recursive: true })
    for (const entry of entries) {
      if (entry.endsWith("/SKILL.md") || entry.endsWith("\\SKILL.md")) {
        const skillDir = entry.replace(/[/\\]SKILL\.md$/, "")
        if (path.basename(skillDir) === name) {
          return path.join(SKILLS_DIR, skillDir)
        }
      }
    }
  } catch {}
  return null
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

async function getAvailableFiles(skillDir: string): Promise<string[]> {
  const files: string[] = []
  for (const subdir of ALLOWED_SUBDIRS) {
    const dir = path.join(skillDir, subdir)
    try {
      const entries = await fs.readdir(dir, { recursive: true })
      for (const entry of entries) {
        const full = path.join(dir, entry)
        try {
          const stat = await fs.stat(full)
          if (stat.isFile()) files.push(path.join(subdir, entry))
        } catch {}
      }
    } catch {}
  }
  return files
}

export async function create(name: string, content: string, category?: string): Promise<ManageResult> {
  let err = validateName(name)
  if (err) return { success: false, error: err }

  err = validateCategory(category)
  if (err) return { success: false, error: err }

  err = validateFrontmatter(content)
  if (err) return { success: false, error: err }

  const existing = await findSkill(name)
  if (existing) return { success: false, error: `Skill '${name}' already exists.` }

  const skillDir = category ? path.join(SKILLS_DIR, category, name) : path.join(SKILLS_DIR, name)

  await fs.mkdir(skillDir, { recursive: true })
  const skillMd = path.join(skillDir, "SKILL.md")
  await atomicWrite(skillMd, content)

  const scan = await scanSkill(skillDir, "agent-created")
  const { allowed, reason } = shouldAllowInstall(scan)

  if (allowed === false) {
    await fs.rm(skillDir, { recursive: true, force: true })
    return { success: false, error: `Security blocked: ${reason}`, scanReport: formatScanReport(scan) }
  }

  SyncEvent.run(SyncEvent.ToolEvent.SkillInstalled, {
    name,
    location: skillDir,
    source: category,
  })

  return {
    success: true,
    message: `Skill '${name}' created.`,
    path: path.relative(SKILLS_DIR, skillDir),
    hint: `To add files, use write_file with file_path='references/example.md'`,
  }
}

export async function edit(name: string, content: string): Promise<ManageResult> {
  const err = validateFrontmatter(content)
  if (err) return { success: false, error: err }

  const existing = await findSkill(name)
  if (!existing) return { success: false, error: `Skill '${name}' not found.` }

  const skillMd = path.join(existing, "SKILL.md")
  const original = await fs.readFile(skillMd, "utf-8").catch(() => null)

  await atomicWrite(skillMd, content)

  const scan = await scanSkill(existing, "agent-created")
  const { allowed } = shouldAllowInstall(scan)

  if (allowed === false) {
    if (original) await atomicWrite(skillMd, original)
    return { success: false, error: "Security blocked", scanReport: formatScanReport(scan) }
  }

  return { success: true, message: `Skill '${name}' updated.` }
}

export async function patch(
  name: string,
  oldString: string,
  newString: string,
  filePath?: string,
  replaceAll = false,
): Promise<ManageResult> {
  if (!oldString) return { success: false, error: "old_string is required." }
  if (newString === undefined) return { success: false, error: "new_string is required." }

  const existing = await findSkill(name)
  if (!existing) return { success: false, error: `Skill '${name}' not found.` }

  const target = filePath ? path.join(existing, filePath) : path.join(existing, "SKILL.md")

  if (filePath) {
    const err = validateFilePath(filePath)
    if (err) return { success: false, error: err }
  }

  const content = await fs.readFile(target, "utf-8").catch(() => null)
  if (!content) return { success: false, error: `File not found: ${filePath || "SKILL.md"}` }

  const count = (content.match(escapeRegex(oldString)) || []).length
  if (count === 0) {
    return { success: false, error: "old_string not found in the file.", filePreview: content.slice(0, 500) }
  }

  if (count > 1 && !replaceAll) {
    return { success: false, error: `old_string matched ${count} times. Provide more context or set replace_all=true.`, matchCount: count }
  }

  const newContent = content.split(oldString).join(newString)

  if (!filePath) {
    const err = validateFrontmatter(newContent)
    if (err) return { success: false, error: `Patch would break SKILL.md: ${err}` }
  }

  await atomicWrite(target, newContent)

  const scan = await scanSkill(existing, "agent-created")
  const { allowed } = shouldAllowInstall(scan)

  if (allowed === false) {
    await atomicWrite(target, content)
    return { success: false, error: "Security blocked", scanReport: formatScanReport(scan) }
  }

  const replacements = replaceAll ? count : 1
  return { success: true, message: `Patched ${filePath || "SKILL.md"} (${replacements} replacement${replacements > 1 ? "s" : ""})` }
}

export async function remove(name: string): Promise<ManageResult> {
  const existing = await findSkill(name)
  if (!existing) return { success: false, error: `Skill '${name}' not found.` }

  await fs.rm(existing, { recursive: true, force: true })

  SyncEvent.run(SyncEvent.ToolEvent.SkillRemoved, { name })

  const parent = path.dirname(existing)
  if (parent !== SKILLS_DIR) {
    try {
      const entries = await fs.readdir(parent)
      if (entries.length === 0) await fs.rmdir(parent)
    } catch {}

  }

  return { success: true, message: `Skill '${name}' deleted.` }
}

export async function writeFile(name: string, filePath: string, fileContent: string): Promise<ManageResult> {
  const err = validateFilePath(filePath)
  if (err) return { success: false, error: err }
  if (fileContent === undefined) return { success: false, error: "file_content is required." }

  const existing = await findSkill(name)
  if (!existing) return { success: false, error: `Skill '${name}' not found.` }

  const target = path.join(existing, filePath)
  const original = await fs.readFile(target, "utf-8").catch(() => null)

  await atomicWrite(target, fileContent)

  const scan = await scanSkill(existing, "agent-created")
  const { allowed } = shouldAllowInstall(scan)

  if (allowed === false) {
    if (original) await atomicWrite(target, original)
    else await fs.unlink(target).catch(() => {})
    return { success: false, error: "Security blocked", scanReport: formatScanReport(scan) }
  }

  return { success: true, message: `File '${filePath}' written.` }
}

export async function removeFile(name: string, filePath: string): Promise<ManageResult> {
  const err = validateFilePath(filePath)
  if (err) return { success: false, error: err }

  const existing = await findSkill(name)
  if (!existing) return { success: false, error: `Skill '${name}' not found.` }

  const target = path.join(existing, filePath)

  if (!(await exists(target))) {
    const available = await getAvailableFiles(existing)
    return { success: false, error: `File '${filePath}' not found.`, availableFiles: available }
  }

  await fs.unlink(target)

  const parent = path.dirname(target)
  if (parent !== existing) {
    try {
      const entries = await fs.readdir(parent)
      if (entries.length === 0) await fs.rmdir(parent)
    } catch {}
  }

  return { success: true, message: `File '${filePath}' removed.` }
}
