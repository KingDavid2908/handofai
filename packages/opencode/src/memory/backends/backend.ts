export type MemoryType = "text" | "image" | "video" | "audio" | "document"

export type MemoryCategory =
  | "user_preferences"
  | "project_knowledge"
  | "code_patterns"
  | "errors"
  | "conversations"
  | "images"
  | "videos"
  | "audio"
  | "documents"

export interface MemoryEntry {
  content: string
  type: MemoryType
  target: "memory" | "user"
  category?: MemoryCategory
  metadata?: Record<string, unknown>
  source?: "manual" | "nudge" | "compaction" | "tool" | "auto-save"
}

export interface SearchOpts {
  target?: "memory" | "user"
  limit?: number
  type?: MemoryType
}

export interface ListOpts {
  target?: "memory" | "user"
  limit?: number
}

export interface MemoryResult {
  id: string
  content: string
  type: MemoryType
  target: "memory" | "user"
  score?: number
  metadata?: Record<string, unknown>
  createdAt?: string
}

export interface AddResult {
  success: boolean
  id?: string
  error?: string
}

export interface RemoveResult {
  success: boolean
  error?: string
}

export interface MemoryBackend {
  readonly id: string
  readonly name: string
  enabled: boolean
  configured: boolean

  init(): Promise<void>
  add(entry: MemoryEntry): Promise<AddResult>
  remove(id: string): Promise<RemoveResult>
  search(query: string, opts?: SearchOpts): Promise<MemoryResult[]>
  list(opts?: ListOpts): Promise<MemoryResult[]>
  supports(type: MemoryType): boolean
}
