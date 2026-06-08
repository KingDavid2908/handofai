import { z } from "zod"

export const VoiceCallConfig = z.object({
  your_number: z.string().optional(),
  providers: z.record(z.string(), z.object({ enabled: z.boolean().default(false) }).catchall(z.any())).optional(),
})

export type VoiceCallConfig = z.infer<typeof VoiceCallConfig>
