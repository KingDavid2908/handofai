import { createMemo } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { Config } from "@/config/config"
import { useToast } from "@tui/ui/toast"
import { LessonStore } from "@/lessons/lesson-store"

const ENTRY_DELIMITER = "\n§\n"

export function DialogLessons() {
  const dialog = useDialog()
  const toast = useToast()

  const ensureInit = async () => {
    if (!LessonStore.isInitialized()) {
      try {
        await LessonStore.init()
      } catch (e) {
        toast.show({ message: `Failed to init lessons: ${e}`, variant: "error" })
      }
    }
  }

  void ensureInit()

  const refreshSnapshot = async () => {
    try {
      await LessonStore.load()
    } catch (e) {
      toast.show({ message: `Failed to refresh: ${e}`, variant: "error" })
    }
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const snap = LessonStore.isInitialized() ? LessonStore.getSnapshot() : null
    const entries = snap?.lessons ? snap.lessons.split(ENTRY_DELIMITER).filter((e) => e.trim()) : []
    const status = snap
      ? `${snap.usage.used}/${snap.usage.limit} chars (${snap.usage.percent}%)`
      : "Initializing..."

    return [
      {
        title: `Lessons  ${entries.length} entries`,
        description: status,
        value: "view",
        category: "Lessons",
      },
      {
        title: "Toggle Lessons",
        description: "Enable or disable lessons injection into system prompt",
        value: "toggle",
        category: "Lessons",
        onSelect: async () => {
          try {
            const cfg = await Config.getGlobal()
            const current = (cfg as any).lessons?.enabled ?? true
            const next = !current
            const lessonsCfg = (cfg as any).lessons ?? {}
            await Config.updateGlobal({
              ...cfg,
              lessons: {
                enabled: next,
                char_limit: lessonsCfg.char_limit ?? 2200,
              },
            })
            toast.show({ message: `Lessons ${next ? "enabled" : "disabled"}`, variant: "success" })
            await refreshSnapshot()
          } catch (e) {
            toast.show({ message: `Error: ${e}`, variant: "error" })
          }
          dialog.clear()
        },
      },
      {
        title: "Clear Lessons",
        description: "Clear all LESSONS.md entries",
        value: "clear",
        category: "Lessons",
        onSelect: async () => {
          try {
            await LessonStore.clear()
            toast.show({ message: "Lessons cleared", variant: "success" })
            await refreshSnapshot()
          } catch (e) {
            toast.show({ message: `Error: ${e}`, variant: "error" })
          }
          dialog.clear()
        },
      },
    ]
  })

  return (
    <DialogSelect
      title="Lessons"
      placeholder="Search lessons actions..."
      options={options()}
    />
  )
}
