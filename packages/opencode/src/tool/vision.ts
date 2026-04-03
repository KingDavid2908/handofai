import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Global } from "../global"
import type { Provider } from "../provider/provider"
import { Provider as ProviderModule } from "../provider/provider"

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

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/webp",
  "image/svg+xml",
])

export const VisionTool = Tool.define("vision", {
  description: "Analyze images using AI vision. Provide an image URL or local file path, and optionally a question about the image.",
  parameters: z.object({
    source: z.string().describe("Image URL (http/https) or local file path to analyze"),
    question: z.string().optional().describe("Specific question about the image (auto-describes if omitted)"),
  }),
  async execute(params, ctx) {
    const currentModel = ctx.extra?.model as Provider.Model | undefined
    if (!currentModel) {
      throw new Error("Could not determine current model. Please ensure you have a model configured.")
    }

    // Download or read image first
    const isUrl = params.source.startsWith("http://") || params.source.startsWith("https://")
    let imageData: Buffer
    let mime: string

    if (isUrl) {
      const url = new URL(params.source)

      if (!await isUrlSafe(url)) {
        throw new Error(`URL blocked: ${params.source} resolves to a private or internal network address.`)
      }

      imageData = await downloadWithRetry(url.toString())
      mime = detectMimeFromUrl(url.toString(), imageData)
    } else {
      let filepath = params.source
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
      mime = Filesystem.mimeType(filepath) ?? "application/octet-stream"
    }

    if (!IMAGE_MIMES.has(mime)) {
      throw new Error(`Unsupported image format: ${mime}. Supported formats: PNG, JPEG, GIF, BMP, WebP, SVG`)
    }

    const dataUrl = `data:${mime};base64,${imageData.toString("base64")}`
    const question = params.question ?? "Describe this image in detail."

    // Check if a vision model is explicitly configured in state
    const stateModel: Record<string, unknown> = await Filesystem.readJson(
      path.join(Global.Path.state, "model.json"),
    ).catch(() => ({}))
    const visionModelEntry = (stateModel.visionModel as { providerID: string; modelID: string } | null) ?? null

    if (visionModelEntry) {
      const { providerID, modelID } = ProviderModule.parseModel(`${visionModelEntry.providerID}/${visionModelEntry.modelID}`)
      const model = await ProviderModule.getModel(providerID, modelID).catch(() => null)

      if (model) {
        const analysis = await analyzeWithModel(dataUrl, question, model)
        return {
          title: `Vision: ${path.basename(params.source)}`,
          output: analysis,
          metadata: {},
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
        title: `Vision: ${path.basename(params.source)}`,
        output: `Image loaded successfully`,
        metadata: {},
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
      case "png": return "image/png"
      case "jpg":
      case "jpeg": return "image/jpeg"
      case "gif": return "image/gif"
      case "bmp": return "image/bmp"
      case "webp": return "image/webp"
      case "svg": return "image/svg+xml"
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
): Promise<string> {
  const language = await ProviderModule.getLanguage(model)

  const { streamText } = await import("ai")

  const result = streamText({
    model: language,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze this image and answer the following question:\n\n${question}`,
          },
          {
            type: "image",
            image: imageDataUrl,
          },
        ],
      },
    ],
    system: "You are a helpful assistant that analyzes images. Provide detailed, accurate descriptions and answers.",
  })

  let response = ""
  for await (const chunk of result.fullStream) {
    if (chunk.type === "text-delta") {
      response += chunk.text
    }
  }

  return response || "No analysis returned from the model."
}
