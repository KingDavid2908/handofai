import { Log } from "@/util/log"
import { Config } from "@/config/config"
import type {
  MemoryBackend,
  MemoryEntry,
  MemoryResult,
  AddResult,
  RemoveResult,
  SearchOpts,
  ListOpts,
  MemoryType,
} from "./backend"

const log = Log.create({ service: "graphlit-backend" })

function isLocalFilePath(url: string): boolean {
  if (url.startsWith("http://") || url.startsWith("https://")) return false
  if (url.startsWith("data:")) return false
  // Windows absolute path: C:\... or C:/...
  if (/^[A-Za-z]:[/\\]/.test(url)) return true
  // Unix absolute path: /...
  if (url.startsWith("/")) return true
  // Relative path: ./... or ../...
  if (url.startsWith("./") || url.startsWith("../")) return true
  return false
}

function pathFromUrl(url: string): string | undefined {
  // Extract filename from path
  const idx = Math.max(url.lastIndexOf("/"), url.lastIndexOf("\\"))
  return idx >= 0 ? url.slice(idx + 1) : undefined
}

function mimeFromPath(url: string): string {
  const ext = url.split(".").pop()?.toLowerCase() || ""
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    xml: "application/xml",
    zip: "application/zip",
    rar: "application/x-rar-compressed",
    "7z": "application/x-7z-compressed",
    tar: "application/x-tar",
    gz: "application/gzip",
  }
  return map[ext] || "application/octet-stream"
}

export class GraphlitBackend implements MemoryBackend {
  readonly id = "graphlit"
  readonly name = "Graphlit"
  enabled = false
  configured = false

  private client: any = null

  async init() {
    const cfg = await this.getConfig()
    if (!cfg?.enabled) {
      this.enabled = false
      this.configured = false
      return
    }

    const orgId = cfg.organization_id || process.env.GRAPHLIT_ORGANIZATION_ID
    const envId = cfg.environment_id || process.env.GRAPHLIT_ENVIRONMENT_ID
    const secret = cfg.jwt_secret || process.env.GRAPHLIT_JWT_SECRET

    if (!orgId || !envId || !secret) {
      this.configured = false
      return
    }

    try {
      // @ts-ignore optional dependency
      const { Graphlit } = await import("graphlit-client")
      this.client = new Graphlit({ organizationId: orgId, environmentId: envId, jwtSecret: secret })

      this.enabled = true
      this.configured = true
      log.info("initialized")
    } catch (err) {
      log.warn("graphlit-client not installed. Run: bun add graphlit-client")
      this.configured = false
    }
  }

  private async getConfig() {
    const cfg = await Config.getGlobal().catch(() => ({} as any))
    return cfg.memory?.backends?.graphlit
  }

  async add(entry: MemoryEntry): Promise<AddResult> {
    if (!this.client || !this.configured) return { success: false, error: "Graphlit not configured" }

    try {
      const name = `memory-${entry.category || entry.type}-${Date.now()}`

      if (entry.type === "text") {
        // Use ingestText for text content → appears in Context > Contents
        const result = await this.client.ingestText(
          entry.content,
          name,
          undefined, // textType
          undefined, // uri
          undefined, // id
          undefined, // identifier
          true,      // isSynchronous
        )
        return { success: true, id: result.ingestText?.id }
      }

      // Media types: image, video, audio, document
      const url = entry.content

      if (url.startsWith("data:")) {
        // Data URI: extract base64, use ingestEncodedFile
        const commaIdx = url.indexOf(",")
        const mime = url.slice(5, commaIdx).split(";")[0]
        const base64 = url.slice(commaIdx + 1)
        const filename = (entry.metadata?.filename as string) || `memory-${Date.now()}`

        const result = await this.client.ingestEncodedFile(
          filename,
          base64,
          mime,
          undefined, // fileCreationDate
          undefined, // fileModifiedDate
          undefined, // id
          undefined, // identifier
          true,      // isSynchronous
        )
        return { success: true, id: result.ingestEncodedFile?.id }
      }

      if (isLocalFilePath(url)) {
        // Local file path: read file, convert to base64, use ingestEncodedFile
        try {
          const file = Bun.file(url)
          const exists = await file.exists()
          if (!exists) {
            return { success: false, error: `File not found: ${url}` }
          }

          const buffer = await file.arrayBuffer()
          const base64 = Buffer.from(buffer).toString("base64")
          const mime = file.type || mimeFromPath(url)
          const filename = (entry.metadata?.filename as string) || pathFromUrl(url) || `memory-${Date.now()}`

          const result = await this.client.ingestEncodedFile(
            filename,
            base64,
            mime,
            undefined, // fileCreationDate
            undefined, // fileModifiedDate
            undefined, // id
            undefined, // identifier
            true,      // isSynchronous
          )
          return { success: true, id: result.ingestEncodedFile?.id }
        } catch (fileErr) {
          const msg = fileErr instanceof Error ? fileErr.message : String(fileErr)
          log.error("file read failed", { path: url, error: msg })
          return { success: false, error: `Failed to read file ${url}: ${msg}` }
        }
      }

      // HTTP/HTTPS URL: use ingestUri
      const result = await this.client.ingestUri(
        url,
        name,
        undefined, // id
        undefined, // identifier
        true,      // isSynchronous
      )
      return { success: true, id: result.ingestUri?.id }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error("add failed", { error: msg })
      return { success: false, error: msg }
    }
  }

  async remove(id: string): Promise<RemoveResult> {
    if (!this.client || !this.configured) return { success: false, error: "Graphlit not configured" }

    try {
      await this.client.deleteContents({ id })
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  async search(query: string, opts?: SearchOpts): Promise<MemoryResult[]> {
    if (!this.client || !this.configured) return []

    try {
      const result = await this.client.queryContents({
        search: query,
      })
      const items = result.queryContents?.results || []
      return items.map((r: any) => ({
        id: r.id,
        content: r.title || r.name || r.id,
        type: "text",
        target: opts?.target || "memory",
        metadata: r.metadata,
      })).slice(0, opts?.limit ?? 20)
    } catch (err) {
      log.error("search failed", { error: err })
      return []
    }
  }

  async list(opts?: ListOpts): Promise<MemoryResult[]> {
    if (!this.client || !this.configured) return []

    try {
      const result = await this.client.queryContents({})
      const items = result.queryContents?.results || []
      return items.map((r: any) => ({
        id: r.id,
        content: r.title || r.name || r.id,
        type: "text",
        target: opts?.target || "memory",
        createdAt: r.creationDate,
        metadata: r.metadata,
      })).slice(0, opts?.limit ?? 20)
    } catch (err) {
      log.error("list failed", { error: err })
      return []
    }
  }

  supports(type: MemoryType): boolean {
    return true // Graphlit supports all content types via ingestion APIs
  }
}
