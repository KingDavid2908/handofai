import { For, type JSX } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { logoLines } from "@/cli/logo"

export function Logo() {
  const { theme } = useTheme()

  return (
    <box>
      <For each={logoLines}>
        {(line) => (
          <text fg={theme.text} selectable={false}>
            {line}
          </text>
        )}
      </For>
    </box>
  )
}
