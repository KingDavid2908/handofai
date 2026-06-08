import { createSimpleContext } from "./helper"
import { createSignal } from "solid-js"

export type VoiceState = {
  active: () => boolean
  setActive: (v: boolean) => void
  energy: () => number
  setEnergy: (v: number) => void
  transcript: () => string
  setTranscript: (v: string) => void
}

export const { use: useVoice, provider: VoiceProvider } = createSimpleContext({
  name: "Voice",
  init: () => {
    const [active, setActive] = createSignal(false)
    const [energy, setEnergy] = createSignal(0)
    const [transcript, setTranscript] = createSignal("")
    return { active, setActive, energy, setEnergy, transcript, setTranscript }
  },
})
