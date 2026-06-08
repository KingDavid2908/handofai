import { createMemo, createSignal } from "solid-js"
import { reconcile } from "solid-js/store"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { useToast } from "@tui/ui/toast"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { DialogPrompt } from "../ui/dialog-prompt"
import { ModelsDev } from "@/provider/models"
import { listDevices } from "@/voice/enumerate-devices"

const STT_MODELS: { id: string; name: string; category: string }[] = [
  { id: "deepgram/nova-3", name: "Deepgram Nova-3 (45 languages)", category: "LiveKit Inference" },
  { id: "deepgram/nova-2", name: "Deepgram Nova-2 (33 languages)", category: "LiveKit Inference" },
  { id: "deepgram/flux-general-en", name: "Deepgram Flux English", category: "LiveKit Inference" },
  { id: "deepgram/flux-general-multi", name: "Deepgram Flux Multilingual", category: "LiveKit Inference" },
  { id: "deepgram/nova-2-conversationalai", name: "Deepgram Nova-2 ConversationalAI", category: "LiveKit Inference" },
  { id: "deepgram/nova-2-phonecall", name: "Deepgram Nova-2 Phonecall", category: "LiveKit Inference" },
  { id: "deepgram/nova-3-medical", name: "Deepgram Nova-3 Medical", category: "LiveKit Inference" },
  { id: "assemblyai/u3-rt-pro", name: "AssemblyAI U3 RT Pro (6 languages)", category: "LiveKit Inference" },
  { id: "assemblyai/universal-streaming", name: "AssemblyAI Universal Streaming", category: "LiveKit Inference" },
  { id: "assemblyai/universal-streaming-multilingual", name: "AssemblyAI Universal Multilingual", category: "LiveKit Inference" },
  { id: "cartesia/ink-whisper", name: "Cartesia Ink Whisper (100 languages)", category: "LiveKit Inference" },
  { id: "elevenlabs/scribe_v2_realtime", name: "ElevenLabs Scribe v2 (190 languages)", category: "LiveKit Inference" },
  { id: "speechmatics/enhanced", name: "Speechmatics Enhanced (61 languages)", category: "LiveKit Inference" },
  { id: "speechmatics/standard", name: "Speechmatics Standard (61 languages)", category: "LiveKit Inference" },
  { id: "xai/stt-1", name: "xAI STT-1 (25 languages)", category: "LiveKit Inference" },
  { id: "openai/whisper-1", name: "OpenAI Whisper", category: "Plugin (BYOK)" },
]

const TTS_MODELS: { id: string; name: string; category: string }[] = [
  { id: "cartesia/sonic-3", name: "Cartesia Sonic-3 (42 languages)", category: "LiveKit Inference" },
  { id: "cartesia/sonic-3.5", name: "Cartesia Sonic-3.5 (40 languages)", category: "LiveKit Inference" },
  { id: "cartesia/sonic-latest", name: "Cartesia Sonic Latest (40 languages)", category: "LiveKit Inference" },
  { id: "cartesia/sonic-turbo", name: "Cartesia Sonic Turbo (9 languages)", category: "LiveKit Inference" },
  { id: "deepgram/aura-2", name: "Deepgram Aura-2 (7 languages)", category: "LiveKit Inference" },
  { id: "elevenlabs/eleven_flash_v2", name: "ElevenLabs Flash v2 (English)", category: "LiveKit Inference" },
  { id: "elevenlabs/eleven_flash_v2_5", name: "ElevenLabs Flash v2.5 (32 languages)", category: "LiveKit Inference" },
  { id: "elevenlabs/eleven_turbo_v2_5", name: "ElevenLabs Turbo v2.5 (32 languages)", category: "LiveKit Inference" },
  { id: "elevenlabs/eleven_multilingual_v2", name: "ElevenLabs Multilingual v2 (29 languages)", category: "LiveKit Inference" },
  { id: "elevenlabs/eleven_v3", name: "ElevenLabs v3 (32 languages)", category: "LiveKit Inference" },
  { id: "inworld/inworld-tts-2", name: "Inworld TTS-2 (15 languages)", category: "LiveKit Inference" },
  { id: "inworld/inworld-tts-1.5-max", name: "Inworld TTS-1.5 Max (15 languages)", category: "LiveKit Inference" },
  { id: "inworld/inworld-tts-1.5-mini", name: "Inworld TTS-1.5 Mini (15 languages)", category: "LiveKit Inference" },
  { id: "rime/arcana", name: "Rime Arcana (9 languages)", category: "LiveKit Inference" },
  { id: "rime/coda", name: "Rime Coda (6 languages)", category: "LiveKit Inference" },
  { id: "rime/mist", name: "Rime Mist (English)", category: "LiveKit Inference" },
  { id: "rime/mistv2", name: "Rime Mistv2 (4 languages)", category: "LiveKit Inference" },
  { id: "rime/mistv3", name: "Rime Mistv3 (5 languages)", category: "LiveKit Inference" },
  { id: "xai/tts-1", name: "xAI TTS-1 (17 languages)", category: "LiveKit Inference" },
  { id: "openai/tts-1", name: "OpenAI TTS-1", category: "Plugin (BYOK)" },
  { id: "yarngpt/tts", name: "YarnGPT TTS (Nigerian accent)", category: "Custom" },
]

const TTS_VOICES: Record<string, { id: string; name: string; gender: string; lang: string }[]> = {
  "cartesia/sonic-3": [
    { id: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc", name: "Jacqueline", gender: "Female", lang: "en-US" },
    { id: "a167e0f3-df7e-4d52-a9c3-f949145efdab", name: "Blake", gender: "Male", lang: "en-US" },
    { id: "5c5ad5e7-1020-476b-8b91-fdcbe9cc313c", name: "Daniela", gender: "Female", lang: "es-MX" },
    { id: "f31cc6a7-c1e8-4764-980c-60a361443dd1", name: "Robyn", gender: "Female", lang: "en-AU" },
  ],
  "cartesia/sonic-3.5": [
    { id: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc", name: "Jacqueline", gender: "Female", lang: "en-US" },
    { id: "a167e0f3-df7e-4d52-a9c3-f949145efdab", name: "Blake", gender: "Male", lang: "en-US" },
    { id: "5c5ad5e7-1020-476b-8b91-fdcbe9cc313c", name: "Daniela", gender: "Female", lang: "es-MX" },
    { id: "f31cc6a7-c1e8-4764-980c-60a361443dd1", name: "Robyn", gender: "Female", lang: "en-AU" },
  ],
  "cartesia/sonic-latest": [
    { id: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc", name: "Jacqueline", gender: "Female", lang: "en-US" },
    { id: "a167e0f3-df7e-4d52-a9c3-f949145efdab", name: "Blake", gender: "Male", lang: "en-US" },
    { id: "5c5ad5e7-1020-476b-8b91-fdcbe9cc313c", name: "Daniela", gender: "Female", lang: "es-MX" },
    { id: "f31cc6a7-c1e8-4764-980c-60a361443dd1", name: "Robyn", gender: "Female", lang: "en-AU" },
  ],
  "cartesia/sonic-turbo": [
    { id: "a167e0f3-df7e-4d52-a9c3-f949145efdab", name: "Blake", gender: "Male", lang: "en-US" },
    { id: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc", name: "Jacqueline", gender: "Female", lang: "en-US" },
  ],
  "deepgram/aura-2": [
    { id: "apollo", name: "Apollo", gender: "Male", lang: "en-US" },
    { id: "athena", name: "Athena", gender: "Female", lang: "en-US" },
    { id: "odysseus", name: "Odysseus", gender: "Male", lang: "en-US" },
    { id: "theia", name: "Theia", gender: "Female", lang: "en-AU" },
  ],
  "elevenlabs/eleven_flash_v2": [
    { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", gender: "Female", lang: "en-GB" },
    { id: "iP95p4xoKVk53GoZ742B", name: "Chris", gender: "Male", lang: "en-US" },
    { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", gender: "Female", lang: "en-US" },
  ],
  "elevenlabs/eleven_flash_v2_5": [
    { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", gender: "Female", lang: "en-GB" },
    { id: "iP95p4xoKVk53GoZ742B", name: "Chris", gender: "Male", lang: "en-US" },
    { id: "cjVigY5qzO86Huf0OWal", name: "Eric", gender: "Male", lang: "es-MX" },
    { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", gender: "Female", lang: "en-US" },
  ],
  "elevenlabs/eleven_turbo_v2_5": [
    { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", gender: "Female", lang: "en-GB" },
    { id: "iP95p4xoKVk53GoZ742B", name: "Chris", gender: "Male", lang: "en-US" },
    { id: "cjVigY5qzO86Huf0OWal", name: "Eric", gender: "Male", lang: "es-MX" },
    { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", gender: "Female", lang: "en-US" },
  ],
  "elevenlabs/eleven_multilingual_v2": [
    { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", gender: "Female", lang: "en-GB" },
    { id: "iP95p4xoKVk53GoZ742B", name: "Chris", gender: "Male", lang: "en-US" },
    { id: "cjVigY5qzO86Huf0OWal", name: "Eric", gender: "Male", lang: "es-MX" },
    { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", gender: "Female", lang: "en-US" },
  ],
  "elevenlabs/eleven_v3": [
    { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", gender: "Female", lang: "en-GB" },
    { id: "iP95p4xoKVk53GoZ742B", name: "Chris", gender: "Male", lang: "en-US" },
    { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", gender: "Female", lang: "en-US" },
  ],
  "inworld/inworld-tts-2": [
    { id: "Ashley", name: "Ashley", gender: "Female", lang: "en-US" },
    { id: "Diego", name: "Diego", gender: "Male", lang: "es-MX" },
    { id: "Edward", name: "Edward", gender: "Male", lang: "en-US" },
    { id: "Olivia", name: "Olivia", gender: "Female", lang: "en-GB" },
  ],
  "inworld/inworld-tts-1.5-max": [
    { id: "Ashley", name: "Ashley", gender: "Female", lang: "en-US" },
    { id: "Diego", name: "Diego", gender: "Male", lang: "es-MX" },
    { id: "Edward", name: "Edward", gender: "Male", lang: "en-US" },
    { id: "Olivia", name: "Olivia", gender: "Female", lang: "en-GB" },
  ],
  "inworld/inworld-tts-1.5-mini": [
    { id: "Ashley", name: "Ashley", gender: "Female", lang: "en-US" },
    { id: "Diego", name: "Diego", gender: "Male", lang: "es-MX" },
    { id: "Edward", name: "Edward", gender: "Male", lang: "en-US" },
    { id: "Olivia", name: "Olivia", gender: "Female", lang: "en-GB" },
  ],
  "rime/arcana": [
    { id: "astra", name: "Astra", gender: "Female", lang: "en-US" },
    { id: "celeste", name: "Celeste", gender: "Female", lang: "en-US" },
    { id: "luna", name: "Luna", gender: "Female", lang: "en-US" },
    { id: "ursa", name: "Ursa", gender: "Male", lang: "en-US" },
  ],
  "rime/coda": [
    { id: "astra", name: "Astra", gender: "Female", lang: "en-US" },
    { id: "celeste", name: "Celeste", gender: "Female", lang: "en-US" },
  ],
  "rime/mist": [
    { id: "luna", name: "Luna", gender: "Female", lang: "en-US" },
  ],
  "rime/mistv2": [
    { id: "luna", name: "Luna", gender: "Female", lang: "en-US" },
    { id: "ursa", name: "Ursa", gender: "Male", lang: "en-US" },
  ],
  "rime/mistv3": [
    { id: "astra", name: "Astra", gender: "Female", lang: "en-US" },
    { id: "celeste", name: "Celeste", gender: "Female", lang: "en-US" },
    { id: "luna", name: "Luna", gender: "Female", lang: "en-US" },
    { id: "ursa", name: "Ursa", gender: "Male", lang: "en-US" },
  ],
  "xai/tts-1": [
    { id: "ara", name: "Ara", gender: "Female", lang: "en-US" },
    { id: "eve", name: "Eve", gender: "Female", lang: "en-US" },
    { id: "leo", name: "Leo", gender: "Male", lang: "en-US" },
    { id: "rex", name: "Rex", gender: "Male", lang: "en-US" },
  ],
  "yarngpt/tts": [
    { id: "Idera", name: "Idera", gender: "Female", lang: "en-NG" },
    { id: "Emma", name: "Emma", gender: "Female", lang: "en-NG" },
    { id: "Zainab", name: "Zainab", gender: "Female", lang: "en-NG" },
    { id: "Osagie", name: "Osagie", gender: "Male", lang: "en-NG" },
    { id: "Wura", name: "Wura", gender: "Female", lang: "en-NG" },
    { id: "Jude", name: "Jude", gender: "Male", lang: "en-NG" },
    { id: "Chinenye", name: "Chinenye", gender: "Female", lang: "en-NG" },
    { id: "Tayo", name: "Tayo", gender: "Male", lang: "en-NG" },
    { id: "Regina", name: "Regina", gender: "Female", lang: "en-NG" },
    { id: "Femi", name: "Femi", gender: "Male", lang: "en-NG" },
    { id: "Adaora", name: "Adaora", gender: "Female", lang: "en-NG" },
    { id: "Umar", name: "Umar", gender: "Male", lang: "en-NG" },
    { id: "Mary", name: "Mary", gender: "Female", lang: "en-NG" },
    { id: "Nonso", name: "Nonso", gender: "Male", lang: "en-NG" },
    { id: "Remi", name: "Remi", gender: "Female", lang: "en-NG" },
    { id: "Adam", name: "Adam", gender: "Male", lang: "en-NG" },
  ],
}

const PROVIDER_KEYS = [
  { id: "openai", name: "OpenAI", env: "OPENAI_API_KEY" },
  { id: "deepgram", name: "Deepgram", env: "DEEPGRAM_API_KEY" },
  { id: "cartesia", name: "Cartesia", env: "CARTESIA_API_KEY" },
  { id: "elevenlabs", name: "ElevenLabs", env: "ELEVENLABS_API_KEY" },
  { id: "rime", name: "Rime", env: "RIME_API_KEY" },
  { id: "mistralai", name: "Mistral AI", env: "MISTRAL_API_KEY" },
  { id: "assemblyai", name: "AssemblyAI", env: "ASSEMBLYAI_API_KEY" },
  { id: "xai", name: "xAI", env: "XAI_API_KEY" },
  { id: "inworld", name: "Inworld", env: "INWORLD_API_KEY" },
  { id: "neuphonic", name: "Neuphonic", env: "NEUPHONIC_API_KEY" },
  { id: "sarvam", name: "Sarvam", env: "SARVAM_API_KEY" },
  { id: "resemble", name: "Resemble AI", env: "RESEMBLE_API_KEY" },
  { id: "ovhcloud", name: "OVHCloud", env: "OVHCLOUD_API_KEY" },
  { id: "yarngpt", name: "YarnGPT (Nigerian TTS)", env: "YARNGPT_API_KEY" },
]

export function DialogVoice() {
  const dialog = useDialog()
  const toast = useToast()
  const sync = useSync()
  const local = useLocal()
  const [cfg, setCfg] = createSignal<any>(null)

  const loadConfig = async () => {
    const c = await Config.getGlobal()
    setCfg(c)
  }

  loadConfig()

  const current = createMemo(() => {
    const c = cfg()
    if (!c) return null
    return c.voice
  })

  const [dynamicModels, setDynamicModels] = createSignal<{
    tts: { id: string; name: string; category: string }[]
    stt: { id: string; name: string; category: string }[]
  }>({ tts: [], stt: [] })

  loadDynamicModels()
  async function loadDynamicModels() {
    const modelsDevData = await ModelsDev.get()
    const authData = await Auth.all()
    const tts: { id: string; name: string; category: string }[] = []
    const stt: { id: string; name: string; category: string }[] = []

    for (const [pid, provider] of Object.entries(modelsDevData)) {
      if (!authData[pid] && !cfg()?.voice?.provider_keys?.[pid]) continue
      for (const [mid, model] of Object.entries(provider.models)) {
        const id = `${pid}/${mid}`
        if (model.modalities?.output?.includes("audio")) {
          tts.push({ id, name: model.name, category: "Custom" })
        }
        if (model.modalities?.input?.includes("audio")) {
          stt.push({ id, name: model.name, category: "Custom" })
        }
      }
    }
    setDynamicModels({ tts, stt })
  }

  const save = async (patch: any) => {
    const c = cfg()
    if (!c) return
    const updated = { ...c, voice: { ...(c.voice || {}), ...patch } }
    const next = await Config.updateGlobal(updated)
    setCfg(next)
    sync.set("config", reconcile(next))
  }

  const openLiveKitSetup = async () => {
    const c = cfg()
    const collected: { url?: string; api_key?: string; api_secret?: string } = {}

    const showUrlPrompt = () => {
      dialog.replace(() => (
        <DialogPrompt
          title="Step 1/3: LiveKit URL"
          placeholder="wss://<project>.livekit.cloud"
          value={c?.voice?.livekit?.url || ""}
          onConfirm={async (url) => {
            collected.url = url
            setTimeout(showKeyPrompt, 50)
          }}
        />
      ))
    }
    const showKeyPrompt = () => {
      dialog.replace(() => (
        <DialogPrompt
          title="Step 2/3: LiveKit API Key"
          placeholder="API..."
          value={c?.voice?.livekit?.api_key || ""}
          onConfirm={async (key) => {
            collected.api_key = key
            setTimeout(showSecretPrompt, 50)
          }}
        />
      ))
    }
    const showSecretPrompt = () => {
      dialog.replace(() => (
        <DialogPrompt
          title="Step 3/3: LiveKit API Secret"
          placeholder="..."
          value={c?.voice?.livekit?.api_secret || ""}
          onConfirm={async (secret) => {
            collected.api_secret = secret
            await save({
              livekit: {
                ...(c?.voice?.livekit || {}),
                ...collected,
              },
            })
            dialog.clear()
            toast.show({ message: "LiveKit credentials saved!", variant: "success", duration: 3000 })
          }}
        />
      ))
    }
    showUrlPrompt()
  }

  const openSttPicker = async () => {
    const c = cfg()
    const dyn = dynamicModels()
    const models = [...STT_MODELS, ...dyn.stt]
    dialog.replace(() => (
      <DialogSelect
        title="Select STT Model"
        options={models.map((m) => ({
          title: m.name,
          value: m.id,
          category: m.category,
          footer: c?.voice?.stt?.model === m.id ? "Current" : undefined,
          onSelect: async () => {
            await save({ stt: { ...(c?.voice?.stt || {}), model: m.id } })
            dialog.clear()
            toast.show({ message: `STT model set to ${m.name}`, variant: "success", duration: 2000 })
          },
        }))}
      />
    ))
  }

  const openTtsPicker = async () => {
    const c = cfg()
    const dyn = dynamicModels()
    const models = [...TTS_MODELS, ...dyn.tts]
    dialog.replace(() => (
      <DialogSelect
        title="Select TTS Model"
        options={models.map((m) => ({
          title: m.name,
          value: m.id,
          category: m.category,
          footer: c?.voice?.tts?.model === m.id ? "Current" : undefined,
          onSelect: async () => {
            await save({ tts: { ...(c?.voice?.tts || {}), model: m.id } })
            setTimeout(() => openVoicePicker(m.id), 50)
          },
        }))}
      />
    ))
  }

  const openVoicePicker = async (modelId: string) => {
    const c = cfg()
    const voices = TTS_VOICES[modelId] || []
    if (voices.length === 0) {
      dialog.clear()
      return
    }
    dialog.replace(() => (
      <DialogSelect
        title="Select Voice"
        options={voices.map((v) => ({
          title: `${v.name} (${v.gender}, ${v.lang})`,
          value: v.id,
          footer: c?.voice?.tts?.voice === v.id ? "Current" : undefined,
          onSelect: async () => {
            await save({ tts: { ...(c?.voice?.tts || {}), voice: v.id } })
            dialog.clear()
            toast.show({ message: `Voice set to ${v.name}`, variant: "success", duration: 2000 })
          },
        }))}
      />
    ))
  }

  const openProviderKeySetup = async (provider: (typeof PROVIDER_KEYS)[0]) => {
    const c = cfg()
    const currentKey = c?.voice?.provider_keys?.[provider.id] || ""

    dialog.replace(() => (
      <DialogPrompt
        title={`${provider.name} API Key`}
        placeholder={`Enter ${provider.name} API key`}
        value={typeof currentKey === "string" ? currentKey : ""}
        onConfirm={async (key) => {
          const updated = {
            provider_keys: {
              ...(c?.voice?.provider_keys || {}),
              [provider.id]: key,
            },
          }
          await save(updated)
          if (key) {
            await Auth.set(`voice_provider_${provider.id}`, { type: "api", key })
          }
          dialog.clear()
          toast.show({ message: `${provider.name} API key saved`, variant: "success", duration: 2000 })
        }}
      />
    ))
  }

  const openYarngptSetup = async () => {
    const c = cfg()
    const collected: { api_key?: string; base_url?: string } = {}

    const showKeyStep = () => {
      dialog.replace(() => (
        <DialogPrompt
          title="YarnGPT API Key"
          placeholder="Enter YarnGPT API key"
          value={c?.voice?.provider_keys?.yarngpt || ""}
          onConfirm={async (key) => {
            collected.api_key = key
            setTimeout(showUrlStep, 50)
          }}
        />
      ))
    }
    const showUrlStep = () => {
      dialog.replace(() => (
        <DialogPrompt
          title="YarnGPT Base URL"
          placeholder="https://yarngpt.ai/api/v1"
          value={c?.voice?.yarngpt?.base_url || "https://yarngpt.ai/api/v1"}
          onConfirm={async (url) => {
            collected.base_url = url || "https://yarngpt.ai/api/v1"
            await save({
              provider_keys: { ...(c?.voice?.provider_keys || {}), yarngpt: collected.api_key },
              yarngpt: { base_url: collected.base_url },
            })
            if (collected.api_key) {
              await Auth.set("voice_provider_yarngpt", { type: "api", key: collected.api_key })
            }
            dialog.clear()
            toast.show({ message: "YarnGPT configured! Set TTS model to YarnGPT to use it.", variant: "success", duration: 3000 })
          }}
        />
      ))
    }
    showKeyStep()
  }

  const openSoxPicker = async () => {
    const c = current()
    const indices = [0, 1, 2, 3, 4]
    dialog.replace(() => (
      <DialogSelect
        title="Select SoX Device (Windows)"
        options={indices.map((idx) => ({
          title: `Device ${idx}`,
          value: String(idx),
          footer: (c?.sox_device ?? "0") === String(idx) ? "Current" : undefined,
          onSelect: async () => {
            await save({ sox_device: String(idx) })
            dialog.clear()
            toast.show({ message: `SoX device set to Device ${idx}`, variant: "success", duration: 2000 })
          },
        }))}
      />
    ))
  }

  const openFfmpegPicker = async () => {
    const c = current()
    const devices = await listDevices()
    if (devices.length === 0) {
      dialog.clear()
      toast.show({ message: "No audio devices found. Ensure ffmpeg is in PATH and a microphone is connected.", variant: "error", duration: 4000 })
      return
    }
    dialog.replace(() => (
      <DialogSelect
        title="Select FFmpeg Device (Windows)"
        options={devices.map((d) => ({
          title: d.name,
          value: d.name,
          description: `Index ${d.idx}`,
          footer: c?.ffmpeg_device === d.name ? "Current" : undefined,
          onSelect: async () => {
            await save({ ffmpeg_device: d.name })
            dialog.clear()
            toast.show({ message: `FFmpeg device set to ${d.name}`, variant: "success", duration: 2000 })
          },
        }))}
      />
    ))
  }

  const openVoiceModePicker = async () => {
    const c = current()
    const currentMode = c?.mode || "off"
    dialog.replace(() => (
      <DialogSelect
        title="Select Voice Mode"
        options={[
          {
            title: "OFF",
            value: "off",
            category: "Modes",
            description: "Voice disabled.",
            footer: currentMode === "off" ? "Current" : undefined,
            onSelect: async () => {
              await save({ mode: "off" })
              dialog.clear()
              toast.show({ message: "Voice: OFF", variant: "info", duration: 2000 })
            },
          },
          {
            title: "Voice Mode (STT only)",
            value: "stt_only",
            category: "Modes",
            description: "Speech-to-text into prompt box. Edit before sending.",
            footer: currentMode === "stt_only" ? "Current" : undefined,
            onSelect: async () => {
              await save({ mode: "stt_only" })
              dialog.clear()
              toast.show({ message: "Voice: ON — speak to transcribe into prompt", variant: "success", duration: 2000 })
            },
          },
        ]}
      />
    ))
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const c = current()
    const sttModel = c?.stt?.model || "deepgram/nova-3"
    const ttsModel = c?.tts?.model || "cartesia/sonic-3"
    const ttsVoice = c?.tts?.voice || "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"
    const livekitConfigured = !!(c?.livekit?.url && c?.livekit?.api_key)
    const voiceMode = c?.mode || "off"

    return [
      {
        title: "Voice Toggle",
        value: "toggle",
        description: `Keybind: Ctrl+N | Mode: ${voiceMode === "stt_only" ? "Voice" : "OFF"}`,
        category: "Mode",
        onSelect: openVoiceModePicker,
      },
      {
        title: "STT Model",
        value: "stt",
        description: sttModel,
        category: "Models",
        onSelect: openSttPicker,
      },
      {
        title: "TTS Model",
        value: "tts",
        description: `${ttsModel} / ${ttsVoice.slice(0, 8)}...`,
        category: "Models",
        onSelect: openTtsPicker,
      },
      {
        title: "LiveKit Credentials",
        value: "livekit",
        description: livekitConfigured ? "Configured" : "Not configured",
        category: "Setup",
        onSelect: openLiveKitSetup,
      },
      ...PROVIDER_KEYS.map((p) => {
        let onSelect = () => openProviderKeySetup(p)
        let desc = c?.provider_keys?.[p.id] ? "Set" : "Not set"
        if (p.id === "yarngpt") {
          onSelect = openYarngptSetup
          desc = "2-step wizard"
        }
        return {
          title: `${p.name} API Key`,
          value: `provider_${p.id}`,
          description: desc,
          category: "Provider Keys",
          onSelect,
        }
      }),
      {
        title: "SoX Device (Windows)",
        value: "sox_device",
        description: c?.sox_device ? `Device ${c.sox_device}` : "Device 0 (default)",
        category: "Capture Devices",
        onSelect: openSoxPicker,
      },
      {
        title: "FFmpeg Device (Windows)",
        value: "ffmpeg_device",
        description: c?.ffmpeg_device || "Not configured",
        category: "Capture Devices",
        onSelect: openFfmpegPicker,
      },
    ]
  })

  return (
    <DialogSelect
      title="Voice Configuration"
      options={options()}
    />
  )
}
