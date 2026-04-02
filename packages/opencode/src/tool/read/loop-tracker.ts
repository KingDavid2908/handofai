import { Log } from "@/util/log"

const log = Log.create({ service: "loop-tracker" })

const WARN_THRESHOLD = 3
const BLOCK_THRESHOLD = 4

interface TaskData {
  lastKey: string | null
  consecutive: number
  readHistory: ReadRegion[]
}

export interface ReadRegion {
  path: string
  offset: number
  limit: number
}

export interface ReadTrackerResult {
  status: "ok" | "warning" | "blocked"
  warning?: string
  error?: string
  consecutiveCount: number
}

const _store = new Map<string, TaskData>()

function regionKey(region: ReadRegion): string {
  return `${region.path}|${region.offset}|${region.limit}`
}

function getTask(taskId: string): TaskData {
  let data = _store.get(taskId)
  if (!data) {
    data = { lastKey: null, consecutive: 0, readHistory: [] }
    _store.set(taskId, data)
  }
  return data
}

export function checkReadLoop(taskId: string, region: ReadRegion): ReadTrackerResult {
  const task = getTask(taskId)
  const key = regionKey(region)

  if (task.lastKey === key) {
    task.consecutive++
  } else {
    task.lastKey = key
    task.consecutive = 1
  }

  const count = task.consecutive

  if (count >= BLOCK_THRESHOLD) {
    return {
      status: "blocked",
      error: `BLOCKED: You have read this exact file region ${count} times consecutively. This appears to be a read loop. Use grep to search for specific content, or use the Task tool with explore agent for full-file analysis.`,
      consecutiveCount: count,
    }
  }

  if (count >= WARN_THRESHOLD) {
    task.readHistory.push(region)
    return {
      status: "warning",
      warning: `You have read this exact file region ${count} times consecutively. If you're looking for something specific, try using the grep tool instead. If you need to process the full file, use the Task tool with explore agent.`,
      consecutiveCount: count,
    }
  }

  task.readHistory.push(region)
  return { status: "ok", consecutiveCount: count }
}

export function notifyOtherToolCall(taskId: string): void {
  const task = _store.get(taskId)
  if (!task) return
  task.consecutive = 0
  task.lastKey = null
}

export function getReadFilesSummary(taskId: string): {
  path: string
  regions: string[]
  totalReads: number
}[] {
  const task = _store.get(taskId)
  if (!task) return []

  const byPath = new Map<string, ReadRegion[]>()
  for (const region of task.readHistory) {
    const list = byPath.get(region.path)
    if (list) list.push(region)
    else byPath.set(region.path, [region])
  }

  const result: { path: string; regions: string[]; totalReads: number }[] = []
  for (const [path, regions] of byPath) {
    result.push({
      path,
      regions: regions.map(r => `lines ${r.offset}-${r.offset + r.limit - 1}`),
      totalReads: regions.length,
    })
  }
  return result
}

export function clearReadTracker(taskId?: string): void {
  if (taskId) {
    _store.delete(taskId)
  } else {
    _store.clear()
  }
}
