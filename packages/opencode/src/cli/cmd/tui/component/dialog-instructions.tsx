import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useKeyboard } from "@opentui/solid"
import { onMount } from "solid-js"

export type DialogInstructionsProps = {
  title: string
  value?: string
  placeholder?: string
  onConfirm?: (value: string) => void
}

export function DialogInstructions(props: DialogInstructionsProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  let textarea: TextareaRenderable

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "return") {
      evt.preventDefault()
      props.onConfirm?.(textarea.plainText)
      dialog.clear()
    }
  })

  onMount(() => {
    dialog.setSize("large")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    }, 1)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <textarea
        ref={(val: TextareaRenderable) => (textarea = val)}
        height={8}
        initialValue={props.value}
        placeholder={props.placeholder ?? "Enter text (Ctrl+Enter to submit)"}
        placeholderColor={theme.textMuted}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.text}
      />
      <box paddingBottom={1} gap={1} flexDirection="row">
        <text fg={theme.text}>
          Ctrl+Enter <span style={{ fg: theme.textMuted }}>submit</span>
        </text>
      </box>
    </box>
  )
}
