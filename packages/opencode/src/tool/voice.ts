import z from "zod"
import { Tool } from "./tool"
import { Config } from "../config/config"
import { Auth } from "../auth"
import { Global } from "../global"
import path from "path"
import crypto from "node:crypto"
import { MessageV2 } from "../session/message-v2"
import { SessionID } from "../session/schema"
import { inference, initializeLogger } from "@livekit/agents"
import { ModelsDev } from "../provider/models"
import { transcribeAudio, resolveSttLang } from "../voice/stt-engine"

initializeLogger({ pretty: false, level: "error" })

const AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/opus",
  "audio/mp4",
  "audio/flac",
  "audio/webm",
])

function isAudioMime(mime: string): boolean {
  return AUDIO_MIMES.has(mime) || mime.startsWith("audio/")
}

export const VoiceTool = Tool.define("voice", {
  description:
    "Transcribe audio to text and synthesize speech from text. " +
    "Use 'transcribe' action when the user sends an audio file or voice message — converts speech audio to text. " +
    "Use 'synthesize' action to convert text into spoken audio (text-to-speech). " +
    "Call this tool automatically when you detect an audio attachment from the user. " +
    "For transcribe: provide 'source' as the audio file path, or omit to auto-detect the most recent audio attachment. " +
    "For synthesize: provide 'text' (required), optional 'voice' ID, optional 'language'. " +
    "Uses LiveKit inference models configured via /voice dialog, falling back to TypeScript tool if not configured.",
  parameters: z.object({
    action: z
      .enum(["transcribe", "synthesize"])
      .describe("Action to perform. 'transcribe' converts speech audio to text. 'synthesize' converts text to speech audio."),
    source: z
      .string()
      .optional()
      .describe("File path or URL of the audio to transcribe. For 'transcribe' action. Omit to auto-detect from the most recent audio attachment in the conversation."),
    text: z
      .string()
      .optional()
      .describe("Text content to convert into speech audio. Required for 'synthesize' action."),
    voice: z
      .string()
      .optional()
      .describe("Voice ID for speech synthesis. Uses the default configured in /voice dialog if omitted. Available voices include Cartesia (Jacqueline, Blake), ElevenLabs (Alice, Chris), YarnGPT (Idera, Emma, Zainab — Nigerian accents), and more."),
    language: z
      .string()
      .optional()
      .describe("Language code for transcription or speech (e.g., 'en', 'es', 'fr', 'multi'). Uses configured default if omitted."),
  }),
  async execute(params, ctx) {
    const cfg = (await Config.getGlobal()) as any
    const vc = cfg.voice

    if (params.action === "transcribe") {
      return await transcribe(params, vc, ctx)
    }

    if (params.action === "synthesize") {
      return await synthesize(params, vc)
    }

    throw new Error(`Unknown voice action: ${params.action}`)
  },
})

async function transcribe(
  params: { source?: string; language?: string },
  vc: any,
  ctx: any,
): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
  let source = params.source

  if (!source || source === "context") {
    const attachment = await findRecentAudioAttachment(ctx.extra?.sessionID as string | undefined)
    if (!attachment) {
      throw new Error(
        "No source provided and no recent audio attachment found in the conversation. " +
          "Please provide an audio file path or URL.",
      )
    }
    source = attachment.url
  }

  const filePath = resolveAudioPath(source!)
  if (!filePath) {
    throw new Error(`Could not resolve audio source: ${source}`)
  }

  const model = vc?.stt?.model || "deepgram/nova-3"
  const language = resolveSttLang(model, params.language || vc?.stt?.language)

  try {
    const text = await transcribeAudio(filePath, model, language, vc)
    return {
      title: `Voice: Transcribed audio`,
      output: text || "[No transcription returned]",
      metadata: { model, language },
    }
  } catch (e: any) {
    throw new Error(`STT transcription failed: ${e.message}`)
  }
}

async function synthesize(
  params: { text?: string; voice?: string },
  vc: any,
): Promise<{ title: string; output: string; metadata: Record<string, any>; attachments?: any[] }> {
  if (!params.text) {
    throw new Error("Text is required for synthesize action.")
  }

  const model = vc?.tts?.model || "cartesia/sonic-3"
  const voice = params.voice || vc?.tts?.voice || "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"

  let audioPath: string
  let provider: string

  if (model === "yarngpt/tts") {
    provider = "yarngpt"
    if (!vc?.provider_keys?.yarngpt) throw new Error("YarnGPT API key not configured in /voice")
    audioPath = await synthesizeWithYarnGPT(params.text, voice, vc)
  } else {
    const [providerID] = model.includes("/") ? model.split("/") : ["", model]
    const modelsDevData = await ModelsDev.get()
    const mdModel = modelsDevData[providerID]?.models?.[model]
    const hasAudioOutput = mdModel?.modalities?.output?.includes("audio")

    if (hasAudioOutput) {
      provider = providerID
      const auth = await Auth.get(providerID).catch(() => null)
      const apiKey = vc?.provider_keys?.[providerID] || ((auth as any)?.key as string | undefined)
      if (!apiKey) throw new Error(`API key not configured for ${providerID}`)
      const apiUrl = mdModel.provider?.api ?? modelsDevData[providerID]?.api
      audioPath = await synthesizeWithOpenAICompatible(params.text, model, voice, apiKey, apiUrl)
    } else {
      provider = "livekit"
      if (!vc?.livekit?.url || !vc?.livekit?.api_key) throw new Error("LiveKit credentials not configured in /voice")
      audioPath = await synthesizeWithLiveKit(params.text, model, voice, vc.livekit)
    }
  }

  return {
    title: `Voice: Synthesized speech`,
    output: `Audio saved to ${audioPath}`,
    metadata: { model, voice, provider },
    attachments: [
      {
        type: "file",
        mime: "audio/wav",
        url: audioPath,
      },
    ],
  }
}

function resolveAudioPath(source: string): string | null {
  if (source.startsWith("file://")) {
    return decodeURIComponent(source.slice(7))
  }
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return null
  }
  return source
}



export async function synthesizeWithYarnGPT(
  text: string,
  voice: string,
  vc: any,
): Promise<string> {
  const baseUrl = vc?.yarngpt?.base_url || "https://yarngpt.ai/api/v1"
  const url = `${baseUrl}/tts`
  const key = vc?.provider_keys?.yarngpt

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, voice, response_format: "mp3" }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`YarnGPT TTS API error (${res.status}): ${body}`)
  }

  const buf = await res.arrayBuffer()
  const outPath = path.join(Global.Path.cache, `voice-tts-${Date.now()}.mp3`)
  await Bun.write(outPath, buf)
  return outPath
}

export async function synthesizeWithOpenAICompatible(
  text: string,
  model: string,
  voice: string,
  apiKey: string,
  apiUrl: string | undefined,
): Promise<string> {
  const baseUrl = apiUrl?.replace(/\/+$/, "") || "https://api.openai.com/v1"
  const url = `${baseUrl}/audio/speech`

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/octet-stream",
    },
    body: JSON.stringify({ input: text, model, voice, response_format: "wav" }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`TTS API error (${res.status}): ${body}`)
  }

  const buf = await res.arrayBuffer()
  const outPath = path.join(Global.Path.cache, `voice-tts-${Date.now()}.wav`)
  await Bun.write(outPath, buf)
  return outPath
}

export async function synthesizeWithLiveKit(
  text: string,
  model: string,
  voice: string,
  livekit: { url: string; api_key: string; api_secret: string },
): Promise<string> {
  const tts = new inference.TTS({
    model: model as any,
    voice,
    apiKey: livekit.api_key,
    apiSecret: livekit.api_secret,
  })

  try {
    const stream = tts.stream()
    stream.pushText(text)
    stream.flush()
    stream.endInput()

    const frames = []
    for await (const event of stream) {
      const ev = event as any
      if (ev.frame) frames.push(ev.frame)
    }

    if (frames.length === 0) {
      throw new Error("TTS synthesis returned no audio frames")
    }

    const first = frames[0] as any
    const sampleRate = first.sampleRate
    const channels = first.channels
    const totalSamples = frames.reduce(
      (sum: number, f: any) => sum + f.samplesPerChannel,
      0,
    )
    const combined = new Int16Array(totalSamples * channels)
    let offset = 0
    for (const frame of frames) {
      const f = frame as any
      combined.set(f.data, offset)
      offset += f.data.length
    }

    const outPath = path.join(Global.Path.cache, `voice-tts-${Date.now()}.wav`)
    await writeWav(outPath, combined, sampleRate, channels)
    return outPath
  } finally {
    await tts.close()
  }
}

async function writeWav(
  filePath: string,
  data: Int16Array,
  sampleRate: number,
  channels: number,
): Promise<void> {
  const bitsPerSample = 16
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const dataSize = data.byteLength
  const headerSize = 44
  const fileSize = headerSize + dataSize

  const buf = Buffer.alloc(fileSize)
  let off = 0

  buf.write("RIFF", off, "ascii"); off += 4
  buf.writeUInt32LE(fileSize - 8, off); off += 4
  buf.write("WAVE", off, "ascii"); off += 4
  buf.write("fmt ", off, "ascii"); off += 4
  buf.writeUInt32LE(16, off); off += 4
  buf.writeUInt16LE(1, off); off += 2
  buf.writeUInt16LE(channels, off); off += 2
  buf.writeUInt32LE(sampleRate, off); off += 4
  buf.writeUInt32LE(byteRate, off); off += 4
  buf.writeUInt16LE(blockAlign, off); off += 2
  buf.writeUInt16LE(bitsPerSample, off); off += 2
  buf.write("data", off, "ascii"); off += 4
  buf.writeUInt32LE(dataSize, off); off += 4

  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(buf, off)

  await Bun.write(filePath, buf)
}

export function createLiveKitJwt(apiKey: string, apiSecret: string): string {
  const header = { alg: "HS256", typ: "JWT" }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    video: { roomJoin: true, canPublish: true, canSubscribe: true },
    iss: apiKey,
    sub: apiKey,
    nbf: now - 60,
    exp: now + 86400,
    jti: crypto.randomUUID(),
  }
  const enc = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url").replace(/=+$/, "")
  const b64 = enc(header) + "." + enc(payload)
  const sig = crypto.createHmac("sha256", apiSecret).update(b64).digest("base64url").replace(/=+$/, "")
  return b64 + "." + sig
}

async function findRecentAudioAttachment(sessionID: string | undefined): Promise<{ url: string; mime: string } | null> {
  if (!sessionID) return null

  try {
    const sid = SessionID.make(sessionID)
    const messages: MessageV2.Info[] = []
    for await (const item of MessageV2.stream(sid)) {
      messages.push(item.info)
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== "user") continue

      const parts = await MessageV2.parts(msg.id)
      for (const part of parts) {
        if (part.type === "file" && isAudioMime(part.mime)) {
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
