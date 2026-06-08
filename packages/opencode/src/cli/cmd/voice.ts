import { cmd } from "./cmd"
import { UI } from "../ui"

export const VoiceCommand = cmd({
  command: "voice",
  describe: "voice settings (configure via /voice in the TUI)",
  handler() {
    UI.println("Use /voice in the TUI to configure voice settings.")
  },
})
