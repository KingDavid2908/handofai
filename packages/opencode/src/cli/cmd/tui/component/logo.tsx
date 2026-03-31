import { TextAttributes, RGBA } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { useTheme, tint } from "@tui/context/theme"
import { logoLines } from "@/cli/logo"

export function Logo() {
  const { theme } = useTheme()

  const fg = theme.foreground as RGBA

  return (
    <box>
      <For each={logoLines}>
        {(line) => (
          <text fg={fg} selectable={false}>
            {line}
          </text>
        )}
      </For>
    </box>
  )
}
