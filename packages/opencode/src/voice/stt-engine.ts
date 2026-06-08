import { inference, initializeLogger } from "@livekit/agents"
import { AudioFrame } from "@livekit/rtc-node"
import { ModelsDev } from "../provider/models"
import { Auth } from "../auth"

initializeLogger({ pretty: false, level: "error" })

const FINAL_TRANSCRIPT = 2
const INTERIM_TRANSCRIPT = 1
const END_OF_SPEECH = 3

export function resolveSttLang(model: string, configured?: string): string {
  const m = model.toLowerCase()
  const enOnly = m.endsWith("-en") || m.includes("flux-general-en")
  if (configured === "multi" && enOnly) return "en"
  if (configured) return configured
  if (enOnly) return "en"
  return "multi"
}

export async function transcribeAudio(
  filePath: string,
  model: string,
  language: string,
  vc: any,
): Promise<string> {
  const [providerID] = model.includes("/") ? model.split("/") : ["", model]
  const modelsDevData = await ModelsDev.get()
  const mdModel = modelsDevData[providerID]?.models?.[model]
  const hasAudioInput = mdModel?.modalities?.input?.includes("audio")

  if (hasAudioInput) {
    const auth = await Auth.get(providerID).catch(() => null)
    const apiKey = vc?.provider_keys?.[providerID] || ((auth as any)?.key as string | undefined)
    if (!apiKey) throw new Error(`API key not configured for ${providerID}`)
    const apiUrl = mdModel.provider?.api ?? modelsDevData[providerID]?.api
    return await transcribeWithOpenAICompatible(filePath, model, language, apiKey, apiUrl)
  }

  if (!vc?.livekit?.url || !vc?.livekit?.api_key || !vc?.livekit?.api_secret) {
    throw new Error("LiveKit credentials not configured in /voice")
  }

  return await transcribeWithLiveKit(filePath, model, language, vc.livekit)
}

async function transcribeWithLiveKit(
  filePath: string,
  model: string,
  language: string,
  livekit: { url: string; api_key: string; api_secret: string },
): Promise<string> {
  const stt = new inference.STT({
    model: model as any,
    language: language as any,
    apiKey: livekit.api_key,
    apiSecret: livekit.api_secret,
    encoding: "pcm_s16le",
    sampleRate: 16000,
  })

  const stream = stt.stream()

  const proc = Bun.spawn([
    "ffmpeg", "-i", filePath,
    "-f", "s16le", "-ar", "16000", "-ac", "1", "-",
    "-loglevel", "error",
  ], { stdout: "pipe", stderr: "pipe" })

  const reader = proc.stdout.getReader()
  const chunks: Buffer[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value as Buffer)
  }
  await proc.exited

  const exit = proc.exitCode
  if (exit !== 0) {
    const err = await Bun.readableStreamToText(proc.stderr)
    throw new Error(`ffmpeg failed (${exit}): ${err}`)
  }
  if (chunks.length === 0) {
    throw new Error("ffmpeg produced no audio data — check the input file format")
  }

  const total = chunks.reduce((s, b) => s + b.length, 0)
  const pcm = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    pcm.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), off)
    off += c.byteLength
  }

  const perFrame = 800
  const int16 = new Int16Array(pcm.buffer)
  if (int16.length === 0) {
    throw new Error("No audio data to transcribe")
  }
  for (let i = 0; i < int16.length; i += perFrame) {
    const end = Math.min(i + perFrame, int16.length)
    const slice = int16.slice(i, end)
    const frame = new AudioFrame(slice, 16000, 1, slice.length)
    stream.pushFrame(frame)
  }
  stream.flush()
  stream.endInput()

  const seen = new Set<number>()
  let text = ""
  let finalCount = 0
  let eosCount = 0
  let eventCount = 0
  let firstFinal: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeoutRej: ((e: Error) => void) | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let closing = false

  const timeout = new Promise<string>((_, rej) => { timeoutRej = rej })

  const resetTimer = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => timeoutRej?.(new Error("timeout")), 30_000)
  }
  resetTimer()

  const textPromise = (async () => {
    for await (const event of stream) {
      eventCount++
      seen.add(event.type)
      if (event.type === END_OF_SPEECH) {
        eosCount++
      }
      if (event.type === FINAL_TRANSCRIPT) {
        finalCount++
        if (!firstFinal && event.alternatives?.length) {
          const a = event.alternatives[0]
          firstFinal = `alt:${event.alternatives.length},text:${a?.text ? JSON.stringify(a.text).slice(0, 40) : "''"},conf:${a?.confidence?.toFixed(3) ?? "?"},words:${a?.words?.length ?? "?"}`
        }
        const t = event.alternatives?.[0]?.text
        if (t) {
          text += (text ? " " : "") + t
          resetTimer()
        }
      }
      if (finalCount > 0 && eosCount === finalCount && !closing) {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          if (finalCount > 0 && eosCount === finalCount) {
            closing = true
            stream.close()
          }
        }, 2_000)
      }
    }
    if (timer) clearTimeout(timer)
    if (settleTimer) clearTimeout(settleTimer)
    return text
  })()

  const audioMs = Math.round(int16.length / 16000 * 1000)

  try {
    const result = await Promise.race([textPromise, timeout])
    if (!result || result.trim().length === 0) {
      const typesStr = [...seen].join(",")
      const sample = firstFinal ? ` ${firstFinal}` : ""
      if (finalCount === 0) {
        throw new Error(`STT returned no text — completed ${eventCount} events ([${typesStr}]) but no FINAL_TRANSCRIPT (model: ${model}, language: ${language}, audio: ${audioMs}ms${sample})`)
      }
      throw new Error(`STT returned no text — ${finalCount} FINAL_TRANSCRIPT event(s) with empty text (model: ${model}, language: ${language}, audio: ${audioMs}ms${sample})`)
    }
    return result
  } catch (e) {
    if (e instanceof Error && e.message === "timeout") {
      const typesStr = [...seen].join(",")
      const sample = firstFinal ? ` ${firstFinal}` : ""
      if (eventCount === 0) {
        throw new Error(`STT timed out after 30s with no response — LiveKit Inference may be unreachable (model: ${model}, language: ${language}, audio: ${audioMs}ms${sample})`)
      }
      if (finalCount === 0) {
        throw new Error(`STT timed out after 30s — session opened (${eventCount} events: [${typesStr}]) but no final transcript (model: ${model}, language: ${language}, audio: ${audioMs}ms${sample})`)
      }
      if (text) {
        if (finalCount > 0 && eosCount >= finalCount) {
          return text
        }
        throw new Error(`STT timed out after 30s with no new output — ${finalCount} transcripts (${eosCount} eos), partial text: ${JSON.stringify(text.slice(0, 200))} (model: ${model}, language: ${language}, audio: ${audioMs}ms [${typesStr}]${sample})`)
      }
      throw new Error(`STT timed out after 30s — received ${finalCount} final transcript(s) but text was empty (model: ${model}, language: ${language}, audio: ${audioMs}ms${sample})`)
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    if (settleTimer) clearTimeout(settleTimer)
    stream.close()
    await stt.close()
  }
}

async function transcribeWithOpenAICompatible(
  filePath: string,
  model: string,
  language: string,
  apiKey: string,
  apiUrl: string | undefined,
): Promise<string> {
  const baseUrl = apiUrl?.replace(/\/+$/, "") || "https://api.openai.com/v1"
  const url = `${baseUrl}/audio/transcriptions`

  const form = new FormData()
  const fileName = filePath.split(/[\\/]/).pop() || "audio"
  form.append("file", new Blob([await Bun.file(filePath).arrayBuffer()]), fileName)
  form.append("model", model)
  form.append("language", language)

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`STT API error (${res.status}): ${body}`)
  }

  const data = (await res.json()) as any
  return data.text || ""
}

export class LiveKitSttStream {
  private stt: inference.STT<any>
  private stream: any
  private closed = false
  private _samples = 0

  constructor(
    model: string,
    language: string,
    livekit: { url: string; api_key: string; api_secret: string },
  ) {
    this.stt = new inference.STT({
      model: model as any,
      language: language as any,
      apiKey: livekit.api_key,
      apiSecret: livekit.api_secret,
      encoding: "pcm_s16le",
      sampleRate: 16000,
    })

    this.stream = this.stt.stream()
  }

  setErrorHandler(h: (msg: string) => void) {
    this.onError = h
  }

  pushFrame(samples: Int16Array) {
    if (this.closed || samples.length === 0) return
    const frame = new AudioFrame(samples, 16000, 1, samples.length)
    this.stream.pushFrame(frame)
    this._samples += samples.length
    if (this._samples >= 3200) {
      this._samples = 0
      this.stream.flush()
    }
  }

  async *events(): AsyncIterableIterator<{ text: string; isFinal: boolean }> {
    const TIMEOUT = 30_000
    let lastEvent = Date.now()
    const iterator = this.stream[Symbol.asyncIterator]()

    while (true) {
      const elapsed = Date.now() - lastEvent
      if (elapsed > TIMEOUT) {
        this.onError?.("STT stream idle timeout — no speech detected for 30s")
        break
      }

      let result: IteratorResult<any>
      try {
        result = await Promise.race([
          iterator.next(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), TIMEOUT - elapsed)
          ),
        ])
      } catch (err: any) {
        if (err.message !== "timeout") throw err
        this.onError?.("STT stream timed out — no response from server")
        break
      }

      if (result.done) break
      const event = result.value
      lastEvent = Date.now()

      if (event.type === FINAL_TRANSCRIPT) {
        const t = event.alternatives?.[0]?.text
        if (t) yield { text: t, isFinal: true }
      } else if (event.type === INTERIM_TRANSCRIPT) {
        const t = event.alternatives?.[0]?.text
        if (t) yield { text: t, isFinal: false }
      }
    }
  }

  onError: ((msg: string) => void) | null = null

  async close() {
    if (this.closed) return
    this.closed = true
    this.stream.close()
    await this.stt.close()
  }
}
