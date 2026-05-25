import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createMemo, createSignal, onMount, createEffect } from "solid-js"
import { Locale } from "@/util/locale"
import { useKeybind } from "../context/keybind"
import { Keybind } from "@/util/keybind"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { DialogSessionRename } from "./dialog-session-rename"
import { useKV } from "../context/kv"
import { createDebouncedSignal } from "../util/signal"
import { Spinner } from "./spinner"
import { Config } from "@/config/config"

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const sdk = useSDK()
  const kv = useKV()

  const [toDelete, setToDelete] = createSignal<string>()
  const [search, setSearch] = createDebouncedSignal("", 150)
  const [scope, setScope] = createSignal<"project" | "global">(kv.get("session_list_scope") as "project" | "global" || "project")
  const [sessions, setSessions] = createSignal<any[]>([])
  const [sessionsLoading, setSessionsLoading] = createSignal(false)

  const fetchSessions = async (s: "project" | "global") => {
    setSessionsLoading(true)
    try {
      if (s === "global") {
        const result = await sdk.client.experimental.session.list({ roots: true, limit: 100 }).catch(() => undefined)
        setSessions(result?.data ?? [])
      } else {
        const dir = sync.data.path.directory
        const result = await sdk.client.session.list({ directory: dir, roots: true, limit: 100 }).catch(() => undefined)
        setSessions(result?.data ?? [])
      }
    } finally {
      setSessionsLoading(false)
    }
  }

  // Fetch on mount and when scope changes
  createEffect(() => {
    const s = scope()
    kv.set("session_list_scope", s)
    fetchSessions(s)
  })

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const options = createMemo(() => {
    const today = new Date().toDateString()
    return (sessions())
      .filter((x) => x.parentID === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .map((x) => {
        const date = new Date(x.time.updated)
        let category = date.toDateString()
        if (category === today) {
          category = "Today"
        }
        const isDeleting = toDelete() === x.id
        const status = sync.data.session_status?.[x.id]
        const isWorking = status?.type === "busy"
        return {
          title: isDeleting ? `Press ${keybind.print("session_delete")} again to confirm` : x.title,
          bg: isDeleting ? theme.error : undefined,
          value: x.id,
          category,
          footer: Locale.time(x.time.updated),
          gutter: isWorking ? <Spinner /> : undefined,
        }
      })
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={sessionsLoading() ? "Loading..." : scope() === "global" ? "Sessions (Global)" : "Sessions (Project)"}
      options={options()}
      skipFilter={true}
      current={currentSessionID()}
      onFilter={(q) => {
        setSearch(q)
        if (!q) fetchSessions(scope())
      }}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
        dialog.clear()
      }}
      keybind={[
        {
          keybind: keybind.all.session_delete?.[0],
          title: "delete",
          onTrigger: async (option) => {
            if (toDelete() === option.value) {
              sdk.client.session.delete({
                sessionID: option.value,
              })
              setToDelete(undefined)
              fetchSessions(scope())
              return
            }
            setToDelete(option.value)
          },
        },
        {
          keybind: keybind.all.session_rename?.[0],
          title: "rename",
          onTrigger: async (option) => {
            dialog.replace(() => <DialogSessionRename session={option.value} />)
          },
        },
        {
          keybind: Keybind.parse("ctrl+g")[0],
          title: `scope: ${scope()}`,
          onTrigger: async () => {
            setScope((s) => (s === "project" ? "global" : "project"))
          },
        },
      ]}
    />
  )
}
