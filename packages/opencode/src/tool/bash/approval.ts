import { Log } from "@/util/log"
import fs from "fs"
import path from "path"
import os from "os"

const log = Log.create({ service: "approval" })
const _sessionApprovals = new Map<string, Set<string>>()
const ALLOWLIST_PATH = path.join(os.homedir(), ".config", "handofai", "approval-allowlist.json")

let _permanentAllowlist: Set<string> | null = null

function loadPermanentAllowlist(): Set<string> {
  if (_permanentAllowlist) return _permanentAllowlist
  try {
    if (fs.existsSync(ALLOWLIST_PATH)) {
      const data = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf-8"))
      _permanentAllowlist = new Set(Array.isArray(data) ? data : [])
    } else {
      _permanentAllowlist = new Set()
    }
  } catch {
    _permanentAllowlist = new Set()
  }
  return _permanentAllowlist
}

function savePermanentAllowlist(): void {
  try {
    const dir = path.dirname(ALLOWLIST_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify([...loadPermanentAllowlist()], null, 2))
  } catch (err) {
    log.warn("failed to save permanent allowlist", { error: String(err) })
  }
}

export interface ApprovalResult {
  approved: boolean
  status: "approved" | "blocked" | "approval_required"
  message: string
  description: string
  patternKey: string
  command: string
}

const DANGEROUS_PATTERNS: { pattern: RegExp; description: string; key: string }[] = [
  { pattern: /\b:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:\b/, description: "Fork bomb", key: "fork_bomb" },
  { pattern: /\brm\s+(-[rfR]*\/[rfR]*|(-[rfR]+\s+)+\/)\b/, description: "Recursive force delete of root", key: "rm_rf_root" },
  { pattern: /\bdd\s+if=\b/, description: "Disk dump — can overwrite disk", key: "dd_if" },
  { pattern: /\bmkfs\b/, description: "Format filesystem", key: "mkfs" },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/, description: "Pipe curl to shell", key: "curl_pipe_sh" },
  { pattern: /\bwget\b.*\|\s*(ba)?sh\b/, description: "Pipe wget to shell", key: "wget_pipe_sh" },
  { pattern: /\bDROP\s+TABLE\b/i, description: "SQL DROP TABLE", key: "drop_table" },
  { pattern: /\bchmod\s+777\s+\/\b/, description: "World-writable root", key: "chmod_777_root" },
  { pattern: /\bchown\s+-R\b.*\s+\/\s*$/, description: "Recursive chown of root", key: "chown_root" },
  { pattern: />\s*\/dev\/sda/, description: "Write to raw disk device", key: "write_disk" },
  { pattern: /\bmv\s+\/\s+\/dev\/null\b/, description: "Move root to null", key: "mv_root_null" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, description: "System shutdown/reboot", key: "shutdown" },
  { pattern: /\bmkfs\.\w+\s+\/dev\//, description: "Format disk device", key: "mkfs_dev" },
  { pattern: /\bfdisk\b.*\/dev\//, description: "Disk partitioning", key: "fdisk" },
  { pattern: /\bformat\s+[a-zA-Z]:/i, description: "Windows format drive", key: "format_drive" },
  { pattern: /\bdel\s+\/[fq]\s+\/s\s+/, description: "Windows force delete", key: "del_force" },
  { pattern: /\brd\s+\/s\s+\/q\s+/, description: "Windows recursive delete", key: "rd_sq" },
  { pattern: /\bnet\s+user\b.*\s+\/add\b/, description: "Create user account", key: "net_user_add" },
  { pattern: /\bpasswd\b/, description: "Change password", key: "passwd" },
  { pattern: /\buseradd\b/, description: "Add user", key: "useradd" },
  { pattern: /\bvisudo\b/, description: "Edit sudoers", key: "visudo" },
  { pattern: /\biptables\s+-F\b/, description: "Flush firewall rules", key: "iptables_flush" },
  { pattern: /\bkillall\b/, description: "Kill all processes", key: "killall" },
  { pattern: /\bpkill\s+-9\s/, description: "Force kill processes", key: "pkill_9" },
  { pattern: /\bsystemctl\s+(stop|disable)\s+(sshd?|firewalld|iptables|ufw)\b/, description: "Disable security service", key: "disable_security" },
  { pattern: /\bexport\s+PATH\s*=\s*['"]?['"]?\s*$/, description: "Clear PATH", key: "clear_path" },
  { pattern: /\brm\s+-rf\s+\$HOME/, description: "Delete home directory", key: "rm_home" },
  { pattern: /tee\s+.*~\/\.ssh\//, description: "Write to SSH config directory", key: "write_ssh_dir" },
  { pattern: />\s*~\/\.config\/handofai\/\.env/, description: "Write to handofai env file", key: "write_env_file" },
  { pattern: />\s*\/etc\//, description: "Write to system config directory", key: "write_etc" },
  { pattern: />\s*\/dev\/sd/, description: "Write to disk device", key: "write_dev_sd" },
  { pattern: />\s*\/boot\//, description: "Write to boot partition", key: "write_boot" },
]

export function checkDangerous(command: string, sessionId: string): ApprovalResult {
  const permanent = loadPermanentAllowlist()
  for (const { pattern, description, key } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      if (permanent.has(key)) {
        return { approved: true, status: "approved", message: "", description: "", patternKey: "", command }
      }
      const approved = _sessionApprovals.get(sessionId)
      if (approved?.has(key)) {
        return { approved: true, status: "approved", message: "", description: "", patternKey: "", command }
      }
      return {
        approved: false, status: "approval_required",
        message: `Dangerous command detected: ${description}`,
        description, patternKey: key, command,
      }
    }
  }
  return { approved: true, status: "approved", message: "", description: "", patternKey: "", command }
}

export function checkAllGuards(command: string, envType: string, sessionId: string): ApprovalResult {
  if (envType !== "local") {
    return { approved: true, status: "approved", message: "", description: "", patternKey: "", command }
  }
  return checkDangerous(command, sessionId)
}

export function approvePattern(sessionId: string, patternKey: string, permanent: boolean = false): void {
  let approved = _sessionApprovals.get(sessionId)
  if (!approved) { approved = new Set(); _sessionApprovals.set(sessionId, approved) }
  approved.add(patternKey)
  if (permanent) {
    loadPermanentAllowlist().add(patternKey)
    savePermanentAllowlist()
    log.info("permanently approved dangerous command pattern", { patternKey })
  } else {
    log.info("approved dangerous command pattern", { sessionId, patternKey })
  }
}

export function clearSessionApprovals(sessionId: string): void {
  _sessionApprovals.delete(sessionId)
}

export function getPermanentAllowlist(): string[] {
  return [...loadPermanentAllowlist()]
}

export function removeFromPermanentAllowlist(patternKey: string): void {
  loadPermanentAllowlist().delete(patternKey)
  savePermanentAllowlist()
  log.info("removed pattern from permanent allowlist", { patternKey })
}
