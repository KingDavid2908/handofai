import { Log } from "@/util/log"
import { spawnSync } from "child_process"
import { which } from "@/util/which"
import { existsSync, statSync } from "fs"

const log = Log.create({ service: "bash-requirements" })

export function findDocker(): string | null {
  const found = which("docker")
  if (found) return found
  const candidates = [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ]
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

export function checkBashRequirements(backendType: string, config: {
  sshHost?: string
  sshUser?: string
}): boolean {
  try {
    if (backendType === "local") return true

    if (backendType === "docker") {
      const docker = findDocker()
      if (!docker) {
        log.error("Docker executable not found")
        return false
      }
      const result = spawnSync(docker, ["version"], { timeout: 5_000 })
      return result.status === 0
    }

    if (backendType === "ssh") {
      if (!config.sshHost || !config.sshUser) {
        log.error("SSH backend selected but ssh_host and ssh_user not configured")
        return false
      }
      if (!which("ssh")) {
        log.error("SSH client not found in PATH")
        return false
      }
      return true
    }

    log.error(`Unknown backend type: ${backendType}`)
    return false
  } catch (err) {
    log.error("requirements check failed", { error: String(err) })
    return false
  }
}
