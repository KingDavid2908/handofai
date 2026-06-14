import { z } from "zod"

export const VoiceConfig = z.object({
  mode: z.enum(["off", "stt_only"]).default("off"),
  keybind: z.string().default("ctrl+n"),
  stt: z
    .object({
      model: z.string().default("deepgram/nova-3"),
      language: z.string().default("multi"),
    })
    .optional(),
  tts: z
    .object({
      model: z.string().default("cartesia/sonic-3"),
      voice: z.string().default("9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"),
    })
    .optional(),
  llm: z
    .object({
      use_active_model: z.boolean().default(true),
      model: z.string().optional(),
    })
    .optional(),
  livekit: z
    .object({
      url: z.string().optional(),
      api_key: z.string().optional(),
      api_secret: z.string().optional(),
    })
    .optional(),
  provider_keys: z.record(z.string(), z.any()).optional(),
  instructions: z.string().optional(),
  sox_device: z.string().optional().default("0"),
  ffmpeg_device: z.string().optional(),
  captureSystemAudio: z.boolean().default(true), // Capture both mic and system audio for interview mode
  systemAudioDevice: z.string().optional(), // Optional override for system audio device
})

export type VoiceConfig = z.infer<typeof VoiceConfig>
