import { resolveSttLang, LiveKitSttStream } from "./stt-engine"

export const ROOM_NAME = "handofai-voice-terminal"

export class VoiceParticipant {
  mic: any = null
  micFfmpeg: any = null
  isRunning = false
  identity = ""
  private _cfg: any = null
  private _onUserSpeaking: (() => void) | null = null
  private _onError: ((msg: string) => void) | null = null
  private _committed = ""
  private _pending = ""
  private _livekitStream: LiveKitSttStream | null = null
  private _sttTask: Promise<void> | null = null
  private speakingThreshold = 2000
  private speakingTimer: any = null
  private wasSpeaking = false
  private _mics: any[] = []

  async connectSttOnly(cfg: any, callbacks: {
    onTranscript?: (text: string, isFinal: boolean) => void
    onUserSpeaking?: () => void
    onError?: (msg: string) => void
  }) {
    this.isRunning = true
    this._cfg = cfg
    this._onUserSpeaking = callbacks.onUserSpeaking || null
    this._onError = callbacks.onError || null
    this._committed = ""
    this._pending = ""

    if (!cfg?.livekit?.url || !cfg?.livekit?.api_key || !cfg?.livekit?.api_secret) {
      this._onError?.("LiveKit credentials not configured in /voice")
      this.isRunning = false
      return
    }

    const model = cfg?.stt?.model || "deepgram/nova-3"
    const language = resolveSttLang(model, cfg?.stt?.language)
    this._livekitStream = new LiveKitSttStream(model, language, cfg.livekit)
    this._livekitStream.setErrorHandler((msg) => {
      this._onError?.(msg)
    })

    this._sttTask = (async () => {
      try {
        for await (const evt of this._livekitStream!.events()) {
          if (!this.isRunning) break
          if (evt.isFinal) {
            const sep = this._committed ? " " : ""
            this._committed += sep + evt.text
            this._pending = ""
            callbacks.onTranscript?.(this._committed, true)
          } else {
            this._pending = evt.text
            const display = this._committed + (this._committed && evt.text ? " " : "") + evt.text
            callbacks.onTranscript?.(display, false)
          }
        }
      } catch (e: any) {
        this._onError?.(`STT stream error: ${e.message}`)
      }
    })()

    await this.startMicLocal((chunk) => {
      if (!this.isRunning) return
      const view = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2)
      this._livekitStream?.pushFrame(new Int16Array(view))
      this.detectSpeaking(chunk)
    })
  }

  private killSox() {
    if (process.platform === "win32") {
      try { Bun.spawnSync(["taskkill", "/F", "/IM", "sox.exe"], { stdio: ["ignore", "ignore", "ignore"] }) } catch {}
    }
  }

  private cleanupMic() {
    if (!this.mic) return
    try { this.mic.removeAllListeners?.() } catch {}
    try { this.mic.stopRecording?.() } catch {}
    this.mic = null
  }

  private async warmupMic(dev: string | undefined) {
    const Mic = (await import("node-microphone")).default
    const w = new Mic({ rate: 16000, channels: 1, device: dev })
    w.startRecording()
    try { w.removeAllListeners() } catch {}
    await Bun.sleep(2000)
    try { w.stopRecording() } catch {}
    try { w.kill?.() } catch {}
  }

  async startSoxCapture(onChunk: (chunk: Buffer) => void): Promise<boolean> {
    try {
      if (process.platform === "win32") await this.warmupMic(this._cfg?.sox_device ?? "0")
      const Mic = (await import("node-microphone")).default
      const dev = process.platform === "win32" ? (this._cfg?.sox_device ?? "0") : undefined
      this.mic = new Mic({ rate: 16000, channels: 1, fileType: "raw", endian: "little", encoding: "signed-integer", useDataEmitter: true, device: dev })
      this._mics.push(this.mic)

      const silent: Buffer[] = []
      let started = false
      let rejectSo: ((err: Error) => void) | null = null

      this.mic.on("data", (chunk: Buffer) => {
        if (!started) {
          silent.push(chunk)
          return
        }
        if (!this.isRunning) return
        onChunk(chunk)
      })

      this.mic.on("error", (err: Error) => {
        rejectSo?.(new Error(err.message))
      })

      this.mic.startRecording()
      const timeout = process.platform === "win32" ? 2000 : 500
      await new Promise<void>((resolve, reject) => {
        rejectSo = reject
        this.mic.on("info", () => {
          if (!this.isRunning) return
          resolve()
        })
        setTimeout(resolve, timeout)
      })
      if (!this.isRunning) { this.cleanupMic(); this.killSox(); return false }

      started = true

      const totalSamples = silent.reduce((s, b) => s + b.length / 2, 0)

      if (totalSamples < 1600) {
        this.cleanupMic()
        this.killSox()
        return false
      }

      let sum = 0
      let count = 0
      for (const buf of silent) {
        const view = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
        for (let i = 0; i < view.length && count < 8000; i++) {
          sum += Math.abs(view[i])
          count++
        }
      }
      const avg = count > 0 ? sum / count : 0

      if (avg < 100) {
        this.cleanupMic()
        this.killSox()
        return false
      }

      for (const buf of silent) {
        onChunk(buf)
      }
      return true
    } catch {
      this.cleanupMic()
      this.killSox()
      return false
    }
  }

  async startMicLocal(onChunk: (chunk: Buffer) => void) {
    if (await this.startSoxCapture(onChunk)) return
    await this.startFfmpegMic(false)
  }

  async startFfmpegMic(toRoom: boolean) {
    const isWin = process.platform === "win32"
    const isMac = process.platform === "darwin"
    let inputArg: string[]
    if (isWin) {
      const dev = this._cfg?.ffmpeg_device
      if (!dev) {
        this._onError?.("FFmpeg capture needs a device — open /voice settings and select one in 'FFmpeg Device (Windows)'")
        return
      }
      inputArg = ["-f", "dshow", "-i", `audio=${dev}`]
    } else if (isMac) {
      inputArg = ["-f", "avfoundation", "-i", ":0"]
    } else {
      inputArg = ["-f", "alsa", "-i", "default"]
    }
    const proc = Bun.spawn([
      "ffmpeg", ...inputArg,
      "-f", "s16le", "-ar", "16000", "-ac", "1", "-",
      "-loglevel", "error",
    ], { stdout: "pipe", stderr: "pipe" })

    this.micFfmpeg = proc
    this._mics.push(proc)

    const reader = proc.stdout.getReader()
    let stderrBuf = ""
    ;(async () => {
      const errReader = proc.stderr.getReader()
      while (true) {
        const { done, value } = await errReader.read()
        if (done) break
        stderrBuf += new TextDecoder().decode(value)
      }
    })()

    const consume = async () => {
      while (this.isRunning) {
        const { done, value } = await reader.read()
        if (done) {
          const code = await proc.exited
          if (code !== 0) {
            this._onError?.(`ffmpeg capture failed (exit ${code}): ${stderrBuf.slice(0, 200)}`)
          }
          break
        }
        const buf = value as Buffer
        if (!toRoom) {
          const view = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
          this._livekitStream?.pushFrame(new Int16Array(view))
        }
      }
    }
    consume()
  }

  private detectSpeaking(chunk: Buffer) {
    if (chunk.length < 16) return
    let sum = 0
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.length / 2))
    for (let i = 0; i < samples.length; i++) {
      sum += Math.abs(samples[i])
    }
    const avg = sum / samples.length

    if (avg > this.speakingThreshold) {
      if (!this.wasSpeaking) {
        this.wasSpeaking = true
        this._onUserSpeaking?.()
      }
      clearTimeout(this.speakingTimer)
      this.speakingTimer = setTimeout(() => {
        this.wasSpeaking = false
      }, 1000)
    }
  }

  async disconnect() {
    this.isRunning = false
    if (this._livekitStream) {
      await this._livekitStream.close()
      this._livekitStream = null
    }
    this._sttTask = null
    for (const m of this._mics) {
      if (m && typeof m.removeAllListeners === "function") try { m.removeAllListeners() } catch {}
      if (m && typeof m.stopRecording === "function") try { m.stopRecording() } catch {}
      if (m && typeof m.kill === "function") try { m.kill() } catch {}
      if (m && typeof m.stop === "function") try { m.stop() } catch {}
    }
    this._mics = []
    this.killSox()
    this.mic = null
    this.micFfmpeg = null
    this._onUserSpeaking = null
    this._committed = ""
    this._pending = ""
  }
}
