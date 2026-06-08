import type { EditorTraits } from "@opentui/core"

export type PromptMode = "normal" | "shell"

export interface PromptTraitsInput {
  mode: PromptMode
  disabled: boolean
  autocompleteVisible: boolean
}

export function computePromptTraits(input: PromptTraitsInput): EditorTraits {
  const capture =
    input.mode === "normal"
      ? input.autocompleteVisible
        ? (["escape", "navigate", "submit", "tab"] as const)
        : (["tab"] as const)
      : undefined
  return {
    capture,
    suspend: input.disabled,
    status: input.mode === "shell" ? "SHELL" : undefined,
  }
}
