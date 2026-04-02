import * as path from "path"

const SENSITIVE_PATH_PREFIXES = ["/etc/", "/boot/", "/usr/lib/systemd/"]
const SENSITIVE_EXACT_PATHS = new Set(["/var/run/docker.sock", "/run/docker.sock"])

export interface SensitivePathResult {
  sensitive: boolean
  path: string
  reason: string
}

export function checkSensitivePath(filepath: string): SensitivePathResult | null {
  if (process.platform === "win32") return null

  const resolved = path.resolve(filepath)

  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (resolved.startsWith(prefix)) {
      return {
        sensitive: true,
        path: filepath,
        reason: `This targets a sensitive system directory (${prefix}). Modifying system files can break your system.`,
      }
    }
  }

  if (SENSITIVE_EXACT_PATHS.has(resolved)) {
    return {
      sensitive: true,
      path: filepath,
      reason: "This targets the Docker socket. Modifying it can compromise container isolation.",
    }
  }

  return null
}
