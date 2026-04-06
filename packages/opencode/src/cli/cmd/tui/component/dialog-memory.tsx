import path from "path"
import { createEffect, createMemo, createSignal } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { MemoryStore } from "@/memory/memory-store"
import { SessionStore } from "@/memory/session-store"
import { Config } from "@/config/config"
import { useToast } from "@tui/ui/toast"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Filesystem } from "@/util/filesystem"
import { Global } from "@/global"

const ENTRY_DELIMITER = "\n§\n"

// Memory file paths (same as memory-store.ts)
const MEMORY_DIR = path.join(Global.Path.config, "memories")
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md")
const USER_FILE = path.join(MEMORY_DIR, "USER.md")

export function DialogMemory() {
  const dialog = useDialog()
  const toast = useToast()

  const [loading, setLoading] = createSignal<string | null>(null)
  const [initDone, setInitDone] = createSignal(MemoryStore.isInitialized())
  const [snapshotRev, setSnapshotRev] = createSignal(0)

  const ensureInit = async () => {
    if (!MemoryStore.isInitialized()) {
      try {
        await MemoryStore.init()
        setInitDone(true)
      } catch (e) {
        toast.show({ message: `Failed to init memory: ${e}`, variant: "error" })
      }
    }
  }

  createEffect(() => {
    if (!initDone()) {
      void ensureInit()
    }
  })

  /**
   * Refresh the snapshot by reloading from disk.
   */
  const refreshSnapshot = async () => {
    try {
      await MemoryStore.load()
      setSnapshotRev((r) => r + 1)
    } catch (e) {
      toast.show({ message: `Failed to refresh: ${e}`, variant: "error" })
    }
  }

  /**
   * Open an editable view for MEMORY.md or USER.md.
   * Uses toast + dialog.clear() to avoid focus issues from dialog.replace() with DialogSelect.
   */
  const openMemoryEdit = async (title: string, target: "memory" | "user") => {
    await refreshSnapshot()

    const snap = MemoryStore.getSnapshot()
    const raw = target === "memory" ? snap?.memory : snap?.user
    const entries = raw ? raw.split(ENTRY_DELIMITER).filter((e) => e.trim()) : []
    const currentContent = entries.join("\n\n")
    const filePath = target === "memory" ? MEMORY_FILE : USER_FILE

    dialog.replace(() => (
      <DialogPrompt
        title={`Edit ${title}`}
        placeholder={`Enter ${title} content (entries separated by blank lines)...`}
        value={currentContent}
        busy={loading() === "edit"}
        busyText="Saving..."
        onConfirm={async (value) => {
          const enabled = await MemoryStore.isEnabled()
          if (!enabled) {
            toast.show({ message: "Memory system is disabled. Enable it via Toggle Memory first.", variant: "error" })
            dialog.clear()
            return
          }

          setLoading("edit")
          try {
            const newEntries = value.split(/\n\n+/).map((e) => e.trim()).filter((e) => e)
            const fileContent = newEntries.join(ENTRY_DELIMITER)
            await Filesystem.write(filePath, fileContent)
            await refreshSnapshot()

            // Show result via toast + dialog.clear() (avoids focus freeze from dialog.replace with DialogSelect)
            const snap = MemoryStore.getSnapshot()
            const updated = target === "memory" ? snap?.memory : snap?.user
            const updatedEntries = updated ? updated.split(ENTRY_DELIMITER).filter((e) => e.trim()) : []
            const usage = snap
              ? `${snap.memoryUsage.used}/${snap.memoryUsage.limit} chars (${snap.memoryUsage.percent}%)`
              : "0 chars"

            toast.show({
              message: `${title}: ${newEntries.length} entries saved. Usage: ${usage}`,
              variant: "success",
            })
            dialog.clear()
          } catch (e) {
            toast.show({ message: `Failed to save ${title}: ${e}`, variant: "error" })
            dialog.clear()
          }
          setLoading(null)
        }}
      />
    ))
  }

  /**
   * Session search using toast + dialog.clear() to avoid focus freeze.
   */
  const openSessionSearch = () => {
    dialog.replace(() => (
      <DialogPrompt
        title="Search Sessions"
        placeholder="Enter search query (leave empty for recent sessions)..."
        busy={loading() === "search"}
        busyText="Searching..."
        onConfirm={async (query) => {
          setLoading("search")
          try {
            if (!query.trim()) {
              const sessions = await SessionStore.getRecentSessions({ limit: 5 })
              if (sessions.length === 0) {
                toast.show({ message: "No sessions found", variant: "info" })
              } else {
                const names = sessions.map((s) => s.title || s.id.slice(0, 8)).join("\n")
                toast.show({ message: `Recent sessions:\n${names}`, variant: "info" })
              }
            } else {
              await SessionStore.rebuildIndex()
              const results = await SessionStore.searchMessages(query, { limit: 5 })
              if (results.length === 0) {
                toast.show({ message: `No results for "${query}"`, variant: "info" })
              } else {
                const content = results.map((r) =>
                  `${r.sessionTitle || r.sessionID.slice(0, 8)}\n${r.preview}`
                ).join("\n\n---\n\n")
                toast.show({ message: `Search results for "${query}":\n${content}`, variant: "info" })
              }
            }
          } catch (e) {
            toast.show({ message: `Search error: ${e}`, variant: "error" })
          }
          dialog.clear()
          setLoading(null)
        }}
      />
    ))
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    snapshotRev()
    const snap = initDone() ? MemoryStore.getSnapshot() : null
    const memEntries = snap?.memory ? snap.memory.split(ENTRY_DELIMITER).filter((e) => e.trim()) : []
    const usrEntries = snap?.user ? snap.user.split(ENTRY_DELIMITER).filter((e) => e.trim()) : []
    const memStatus = snap
      ? `${snap.memoryUsage.used}/${snap.memoryUsage.limit} chars (${snap.memoryUsage.percent}%)`
      : "Initializing..."
    const userStatus = snap
      ? `${snap.userUsage.used}/${snap.userUsage.limit} chars (${snap.userUsage.percent}%)`
      : "Initializing..."

    return [
      {
        title: `MEMORY.md  ${memEntries.length} entries`,
        description: memStatus,
        value: "memory-edit",
        category: "Memory",
        onSelect: async () => {
          openMemoryEdit("MEMORY.md", "memory")
        },
      },
      {
        title: `USER.md  ${usrEntries.length} entries`,
        description: userStatus,
        value: "user-edit",
        category: "Memory",
        onSelect: async () => {
          openMemoryEdit("USER.md", "user")
        },
      },
      {
        title: "Search Sessions",
        description: "Search past sessions with FTS5",
        value: "search",
        category: "Memory",
        onSelect: async () => {
          openSessionSearch()
        },
      },
      {
        title: "Recent Sessions",
        description: "List recent sessions",
        value: "sessions",
        category: "Memory",
        onSelect: async () => {
          try {
            const sessions = await SessionStore.getRecentSessions({ limit: 5 })
            if (sessions.length === 0) {
              toast.show({ message: "No sessions found", variant: "info" })
            } else {
              const names = sessions.map((s) => s.title || s.id.slice(0, 8)).join("\n")
              toast.show({ message: `Recent sessions:\n${names}`, variant: "info" })
            }
          } catch (e) {
            toast.show({ message: `Error: ${e}`, variant: "error" })
          }
          dialog.clear()
        },
      },
      {
        title: "Clear Memory",
        description: "Clear all MEMORY.md entries",
        value: "clear",
        category: "Memory",
        onSelect: async () => {
          try {
            await MemoryStore.clear("memory")
            toast.show({ message: "Memory cleared", variant: "success" })
            await refreshSnapshot()
          } catch (e) {
            toast.show({ message: `Error: ${e}`, variant: "error" })
          }
          dialog.clear()
        },
      },
      {
        title: "Clear User Profile",
        description: "Clear all USER.md entries",
        value: "clear-user",
        category: "Memory",
        onSelect: async () => {
          try {
            await MemoryStore.clear("user")
            toast.show({ message: "User profile cleared", variant: "success" })
            await refreshSnapshot()
          } catch (e) {
            toast.show({ message: `Error: ${e}`, variant: "error" })
          }
          dialog.clear()
        },
      },
      {
        title: "Toggle Memory",
        description: "Enable or disable the memory system",
        value: "toggle",
        category: "Memory",
        onSelect: async () => {
          try {
            const cfg = await Config.getGlobal()
            const current = (cfg as any).memory?.enabled ?? true
            const next = !current
            const memCfg = (cfg as any).memory ?? {}
            await Config.updateGlobal({
              ...cfg,
              memory: {
                enabled: next,
                memory_enabled: memCfg.memory_enabled ?? true,
                user_profile_enabled: memCfg.user_profile_enabled ?? true,
                nudge_interval: memCfg.nudge_interval ?? 10,
                flush_min_turns: memCfg.flush_min_turns ?? 6,
                memory_char_limit: memCfg.memory_char_limit ?? 2200,
                user_char_limit: memCfg.user_char_limit ?? 1375,
                skill_creation_nudge_interval: memCfg.skill_creation_nudge_interval ?? 10,
                review_enabled: memCfg.review_enabled ?? true,
              },
            })
            toast.show({ message: `Memory ${next ? "enabled" : "disabled"}`, variant: "success" })
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
      title="Memory"
      placeholder="Search memory actions..."
      options={options()}
    />
  )
}
