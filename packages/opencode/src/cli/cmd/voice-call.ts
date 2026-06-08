import { cmd } from "./cmd"
import { Config } from "../../config/config"
import { UI } from "../ui"

export const VoiceCallCommand = cmd({
  command: "voice-call",
  describe: "manage phone calling providers",
  builder: (yargs) =>
    yargs
      .command("list", "list configured phone providers", {}, async () => {
        const cfg = (await Config.getGlobal()) as any
        const vc = cfg.voice_call
        if (!vc?.providers || Object.keys(vc.providers).length === 0) {
          UI.println("No phone providers configured.")
          return
        }
        for (const [id, p] of Object.entries(vc.providers as Record<string, any>)) {
          const status = p.enabled ? "enabled" : "disabled"
          UI.println(`${id}: ${status}`)
        }
      })
      .command("status", "show voice call status", {}, async () => {
        const cfg = (await Config.getGlobal()) as any
        const vc = cfg.voice_call
        UI.println(`Your number: ${vc?.your_number || "not set"}`)
        const providers = vc?.providers || {}
        const enabled = Object.entries(providers).filter(([, p]: [string, any]) => p.enabled)
        UI.println(`Providers: ${enabled.length} enabled`)
      }),
  handler() {},
})
