import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useVoice } from "@tui/context/voice"
import { createSignal, onMount, onCleanup, createMemo } from "solid-js"

export function VoiceIndicator() {
  const { theme } = useTheme()
  const { active, energy } = useVoice()
  const [tick, setTick] = createSignal(Date.now())

  let interval: ReturnType<typeof setInterval>
  onMount(() => {
    interval = setInterval(() => setTick(Date.now()), 60)
  })
  onCleanup(() => {
    if (interval) clearInterval(interval)
  })

  if (!active()) return null

  const t = tick()
  const e = energy()

  const pulse = createMemo(() => {
    return 0.3 + 0.7 * Math.sin(t * 0.004)
  })

  const p = pulse()
  const dr = Math.round(80 * p)
  const dg = Math.round(255 * p)
  const db = Math.round(100 * p)
  const dotC = `rgb(${dr},${dg},${db})`

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={true}
      borderColor={theme.textMuted}
      paddingLeft={4}
      paddingRight={4}
      paddingTop={2}
      paddingBottom={2}
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
      gap={1}
    >
      <text fg={dotC} attributes={TextAttributes.BOLD}>●</text>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>Listening</text>
    </box>
  )
}
