const DEFAULT_KEYWORDS = [
  "remember",
  "save this",
  "don't forget",
  "note that",
  "keep in mind",
  "make sure to remember",
  "log this",
  "write this down",
  "store this",
  "memorize",
]

export namespace MemoryKeywordDetect {
  export function detect(text: string): boolean {
    const lower = text.toLowerCase()
    for (const kw of DEFAULT_KEYWORDS) {
      if (lower.includes(kw.toLowerCase())) return true
    }
    return false
  }

  export function buildNudge(): string {
    return `[MEMORY TRIGGER DETECTED]
The user wants you to remember something. Use the memory tool to save this information.
- Use target: "user" for cross-project preferences (e.g., "I prefer dark mode")
- Use target: "memory" for project-specific knowledge (e.g., "This project uses Vite")
- Keep entries concise and searchable`
  }
}
