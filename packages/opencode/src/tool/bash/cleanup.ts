import { Log } from "@/util/log"
import fs from "fs"
import path from "path"
import os from "os"
import { getProcessRegistry } from "./process-registry"

const log = Log.create({ service: "cleanup" })

let _cleanupTimer: ReturnType<typeof setInterval> | null = null
let _cleanupRunning = false

export interface BackendLike {
  cleanup(): Promise<void>
}

export function cleanupInactiveBackends(
  cache: Map<string, BackendLike>,
  lastActivity: Map<string, number>,
  locks: Map<string, Promise<BackendLike>>,
  lifetimeSeconds: number = 300,
): void {
  const now = Date.now()
  const staleKeys: string[] = []

  for (const [key, lastTime] of lastActivity) {
    const [taskId] = key.split(":")
    const registry = getProcessRegistry()
    if (registry.hasActiveProcesses(taskId)) {
      lastActivity.set(key, now)
      continue
    }

    if (now - lastTime > lifetimeSeconds * 1000) {
      staleKeys.push(key)
    }
  }

  for (const key of staleKeys) {
    const backend = cache.get(key)
    if (backend) {
      cache.delete(key)
      lastActivity.delete(key)
      locks.delete(key)
      backend.cleanup().catch(err => {
        const msg = String(err)
        if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
          log.info("backend already cleaned up", { key })
        } else {
          log.warn("error cleaning up backend", { key, error: msg })
        }
      })
    }
  }

  if (staleKeys.length > 0) {
    log.info("cleaned up inactive backends", { count: staleKeys.length })
  }
}

export function startCleanupThread(
  cache: Map<string, BackendLike>,
  lastActivity: Map<string, number>,
  locks: Map<string, Promise<BackendLike>>,
  lifetimeSeconds: number = 300,
): void {
  if (_cleanupTimer) return
  _cleanupRunning = true
  _cleanupTimer = setInterval(() => {
    if (!_cleanupRunning) return
    try {
      cleanupInactiveBackends(cache, lastActivity, locks, lifetimeSeconds)
    } catch (err) {
      log.warn("error in cleanup thread", { error: String(err) })
    }
  }, 60_000)
}

export function stopCleanupThread(): void {
  _cleanupRunning = false
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer)
    _cleanupTimer = null
  }
}

export async function cleanupBackend(
  cache: Map<string, BackendLike>,
  lastActivity: Map<string, number>,
  locks: Map<string, Promise<BackendLike>>,
  taskId: string,
): Promise<void> {
  const toRemove: BackendLike[] = []
  for (const [key, backend] of cache) {
    if (key.startsWith(`${taskId}:`)) {
      toRemove.push(backend)
      cache.delete(key)
      lastActivity.delete(key)
      locks.delete(key)
    }
  }
  await Promise.all(toRemove.map(b => b.cleanup()))

  try {
    const sandboxDir = path.join(os.homedir(), ".config", "handofai", "sandboxes")
    const entries = fs.readdirSync(sandboxDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.includes(taskId.slice(0, 8))) {
        fs.rmSync(path.join(sandboxDir, entry.name), { recursive: true, force: true })
      }
    }
  } catch { /* ignore */ }
}

export async function cleanupAll(
  cache: Map<string, BackendLike>,
  lastActivity: Map<string, number>,
  locks: Map<string, Promise<BackendLike>>,
): Promise<number> {
  const count = cache.size
  const backends = [...cache.values()]
  cache.clear()
  lastActivity.clear()
  locks.clear()
  await Promise.all(backends.map(b => b.cleanup()))

  try {
    const sandboxDir = path.join(os.homedir(), ".config", "handofai", "sandboxes")
    fs.rmSync(sandboxDir, { recursive: true, force: true })
  } catch { /* ignore */ }
  log.info("cleaned up all backends", { count })
  return count
}

export function registerAtexitCleanup(
  cache: Map<string, BackendLike>,
): void {
  process.on("exit", () => {
    stopCleanupThread()
    if (cache.size > 0) {
      log.info("shutting down remaining backends", { count: cache.size })
      for (const backend of cache.values()) {
        try { backend.cleanup() } catch {}
      }
    }
  })
}
