import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Global } from "../global"
import type { Provider } from "../provider/provider"
import { Provider as ProviderModule } from "../provider/provider"
import Decimal from "decimal.js"
import { MessageV2 } from "../session/message-v2"
import { SessionID } from "../session/schema"

const MAX_DOWNLOAD_SIZE = 10 * 1024 * 1024
const RETRY_DELAYS = [2000, 4000, 8000]

const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/,
  /^fd00:/,
]

const MEDIA_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/webp",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
])

function isMediaMime(mime: string): boolean {
  return MEDIA_MIMES.has(mime) || mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/")
}

export const VisionTool = Tool.define("vision", {
  description:
    "Analyze images, videos, and audio using a dedicated vision-capable model (separate from the current model). " +
    "Call this tool when the user pastes or attaches an image/video/audio — the vision model handles it regardless of whether the current model supports image input. " +
    "Pass a URL (http/https), local file path, data: URI, or omit source to auto-detect the most recent attachment in the conversation.",
  parameters: z.object({
    source: z
      .string()
      .optional()
      .describe("Image/video/audio URL, file path, data: URI, or omit to use the most recent pasted attachment. This tool uses a separate vision model and works even if the current model lacks vision capabilities."),
    question: z.string().optional().describe("Specific question about the media (auto-describes if omitted)"),
  }),
  async execute(params, ctx) {
    const currentModel = ctx.extra?.model as Provider.Model | undefined
    if (!currentModel) {
      throw new Error("Could not determine current model. Please ensure you have a model configured.")
    }

    let source = params.source
    let imageData: Buffer
    let mime: string

    // Auto-detect from conversation context if no source provided
    if (!source || source === "context") {
      const attachment = await findRecentAttachment(ctx.extra?.sessionID as string | undefined)
      if (!attachment) {
        throw new Error(
          "No source provided and no recent image/video attachment found in the conversation. " +
            "Please provide a URL, file path, data: URI, or paste an image into the prompt.",
        )
      }
      if (attachment.url.startsWith("data:")) {
        source = attachment.url
      } else if (attachment.url.startsWith("http")) {
        source = attachment.url
      } else {
        source = attachment.url
      }
      mime = attachment.mime
    }

    // Parse data: URI
    if (source!.startsWith("data:")) {
      const match = source!.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) {
        throw new Error("Invalid data: URI format. Expected data:<mime>;base64,<payload>")
      }
      mime = match[1]
      imageData = Buffer.from(match[2], "base64")
    } else if (source!.startsWith("http://") || source!.startsWith("https://")) {
      const url = new URL(source!)

      if (!(await isUrlSafe(url))) {
        throw new Error(`URL blocked: ${source} resolves to a private or internal network address.`)
      }

      imageData = await downloadWithRetry(url.toString())
      mime = detectMimeFromUrl(url.toString(), imageData)
    } else {
      let filepath = source!
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(Instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = Filesystem.normalizePath(filepath)
      }

      const exists = await Filesystem.exists(filepath)
      if (!exists) {
        throw new Error(`File not found: ${filepath}`)
      }

      imageData = await Filesystem.readBytes(filepath)
      mime = await Filesystem.mimeType(filepath) ?? "application/octet-stream"
    }

    if (!isMediaMime(mime)) {
      throw new Error(
        `Unsupported media format: ${mime}. Supported formats: PNG, JPEG, GIF, BMP, WebP, SVG, MP4, WebM, QuickTime`,
      )
    }

    const dataUrl = `data:${mime};base64,${imageData.toString("base64")}`
    const question = params.question ?? "Describe this media in detail."
    const isVideo = mime.startsWith("video/")
    const mediaLabel = isVideo ? "Video" : "Image"

    // Check if a vision model is explicitly configured in state
    const stateModel: Record<string, unknown> = await Filesystem.readJson(
      path.join(Global.Path.state, "model.json"),
    ).catch(() => ({}))
    const visionModelEntry = (stateModel.visionModel as { providerID: string; modelID: string } | null) ?? null

    if (visionModelEntry) {
      const { providerID, modelID } = ProviderModule.parseModel(
        `${visionModelEntry.providerID}/${visionModelEntry.modelID}`,
      )
      const model = await ProviderModule.getModel(providerID, modelID).catch(() => null)

      if (model) {
        const { analysis, cost } = await analyzeWithModel(dataUrl, question, model, isVideo)
        return {
          title: `Vision: ${mediaLabel}`,
          output: analysis,
          metadata: { cost },
        }
      }

      throw new Error(
        `Configured vision model "${visionModelEntry.providerID}/${visionModelEntry.modelID}" is no longer available. ` +
          `Set a vision model with /vision command, or switch to a vision-capable model for this session.`,
      )
    }

    // No vision model configured — check if current model has vision
    if (currentModel.capabilities.input.image) {
      return {
        title: `Vision: ${mediaLabel}`,
        output: `${mediaLabel} loaded successfully`,
        metadata: { cost: 0 },
        attachments: [
          {
            type: "file",
            mime,
            url: dataUrl,
          },
        ],
      }
    }

    throw new Error(
      `Your current model "${currentModel.id}" does not support vision. ` +
        `Set a vision model with /vision command, or switch to a vision-capable model for this session.`,
    )
  },
})

async function findRecentAttachment(
  sessionID: string | undefined,
): Promise<{ url: string; mime: string } | null> {
  if (!sessionID) return null

  try {
    const sid = SessionID.make(sessionID)
    const messages: MessageV2.Info[] = []
    for await (const item of MessageV2.stream(sid)) {
      messages.push(item.info)
    }

    // Scan backwards through messages for file attachments
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== "user") continue

      const parts = await MessageV2.parts(msg.id)
      for (const part of parts) {
        if (part.type === "file" && isMediaMime(part.mime)) {
          // Prefer real filesystem path from source for clipboard/temp images
          const sourcePath = (part as any).source?.path as string | undefined
          if (sourcePath && typeof sourcePath === "string" && sourcePath.length > 0) {
            const placeholderNames = new Set(["clipboard", "image", "video", "audio", "paste"])
            if (!placeholderNames.has(sourcePath) && !sourcePath.startsWith("data:")) {
              return { url: sourcePath, mime: part.mime }
            }
          }
          return { url: part.url, mime: part.mime }
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return null
}

async function isUrlSafe(url: URL): Promise<boolean> {
  try {
    const hostname = url.hostname.toLowerCase()
    if (hostname === "localhost" || hostname === "metadata.google.internal" || hostname === "metadata.goog") {
      return false
    }

    const { promisify } = await import("util")
    const { lookup } = await import("dns")
    const dnsLookup = promisify(lookup)

    const addresses = await dnsLookup(hostname, { all: true })
    for (const addr of addresses) {
      const ip = addr.address
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(ip)) {
          return false
        }
      }
      if (ip.startsWith("100.")) {
        return false
      }
    }

    return true
  } catch {
    return false
  }
}

async function downloadWithRetry(url: string, signal?: AbortSignal): Promise<Buffer> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt < RETRY_DELAYS.length + 1; attempt++) {
    try {
      const response = await fetch(url, { signal })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const contentLength = response.headers.get("content-length")
      if (contentLength && parseInt(contentLength) > MAX_DOWNLOAD_SIZE) {
        throw new Error(`Download too large (${contentLength} bytes, max ${MAX_DOWNLOAD_SIZE})`)
      }

      const arrayBuffer = await response.arrayBuffer()
      if (arrayBuffer.byteLength > MAX_DOWNLOAD_SIZE) {
        throw new Error(`Download too large (${arrayBuffer.byteLength} bytes, max ${MAX_DOWNLOAD_SIZE})`)
      }

      return Buffer.from(arrayBuffer)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (error instanceof Error && error.name === "AbortError") {
        throw error
      }

      if (attempt < RETRY_DELAYS.length) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]))
      }
    }
  }

  throw lastError ?? new Error("Download failed after all retries")
}

function detectMimeFromUrl(url: string, data: Buffer): string {
  if (data.length >= 4) {
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png"
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg"
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "image/gif"
    if (data[0] === 0x42 && data[1] === 0x4d) return "image/bmp"
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return "image/webp"
  }

  try {
    const pathname = new URL(url).pathname
    const ext = pathname.split(".").pop()?.toLowerCase()
    switch (ext) {
      case "png":
        return "image/png"
      case "jpg":
      case "jpeg":
        return "image/jpeg"
      case "gif":
        return "image/gif"
      case "bmp":
        return "image/bmp"
      case "webp":
        return "image/webp"
      case "svg":
        return "image/svg+xml"
      case "mp4":
        return "video/mp4"
      case "webm":
        return "video/webm"
      case "mov":
        return "video/quicktime"
    }
  } catch {
    // Ignore URL parsing errors
  }

  return "application/octet-stream"
}

async function analyzeWithModel(
  imageDataUrl: string,
  question: string,
  model: Provider.Model,
  isVideo: boolean,
): Promise<{ analysis: string; cost: number }> {
  const language = await ProviderModule.getLanguage(model)

  const { streamText } = await import("ai")

  const mediaType = isVideo ? "video" : "image"

  const result = streamText({
    model: language,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze this ${mediaType} and answer the following question:\n\n${question}`,
          },
          {
            type: isVideo ? ("image" as any) : "image",
            image: imageDataUrl,
          },
        ],
      },
    ],
    system: `You are a helpful assistant that analyzes ${mediaType}s. Provide detailed, accurate descriptions and answers.`,
  })

  let response = ""
  let usage: any = null
  for await (const chunk of result.fullStream) {
    if (chunk.type === "text-delta") {
      response += chunk.text
    }
    if (chunk.type === "finish") usage = chunk.totalUsage
  }

  const cost = calcCost(model, usage)
  return { analysis: response || "No analysis returned from the model.", cost }
}

function calcCost(model: Provider.Model, usage: any): number {
  if (!usage) return 0
  const safe = (v: number) => (Number.isFinite(v) ? v : 0)
  const inputTokens = safe(usage.inputTokens ?? 0)
  const outputTokens = safe(usage.outputTokens ?? 0)
  const reasoningTokens = safe(usage.reasoningTokens ?? 0)
  const cacheRead = safe(usage.cachedInputTokens ?? 0)
  const cacheWrite = safe(usage.cacheCreationInputTokens ?? 0)
  const adjustedInput = safe(inputTokens - cacheRead - cacheWrite)
  const costInfo =
    model.cost?.experimentalOver200K && adjustedInput + cacheRead > 200_000
      ? model.cost.experimentalOver200K
      : model.cost
  if (!costInfo) return 0
  return safe(
    new Decimal(0)
      .add(new Decimal(adjustedInput).mul(costInfo.input ?? 0).div(1_000_000))
      .add(new Decimal(outputTokens).mul(costInfo.output ?? 0).div(1_000_000))
      .add(new Decimal(cacheRead).mul(costInfo.cache?.read ?? 0).div(1_000_000))
      .add(new Decimal(cacheWrite).mul(costInfo.cache?.write ?? 0).div(1_000_000))
      .add(new Decimal(reasoningTokens).mul(costInfo.output ?? 0).div(1_000_000))
      .toNumber(),
  )
}
