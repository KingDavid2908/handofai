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
import { MemoryRouter } from "@/memory/router"
import { DialogMemoryModel } from "./dialog-memory-model"

const ENTRY_DELIMITER = "\n§\n"

const MEMORY_DIR = path.join(Global.Path.config, "memories")
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md")
const USER_FILE = path.join(MEMORY_DIR, "USER.md")

export function DialogMemory() {
  const dialog = useDialog()
  const toast = useToast()

  const [loading, setLoading] = createSignal<string | null>(null)
  const [initDone, setInitDone] = createSignal(MemoryStore.isInitialized())
  const [snapshotRev, setSnapshotRev] = createSignal(0)
  const [router, setRouter] = createSignal<MemoryRouter | null>(null)

  const ensureInit = async () => {
    if (!MemoryStore.isInitialized()) {
      try {
        await MemoryStore.init()
        setInitDone(true)
        const r = await MemoryStore.getRouter()
        setRouter(r)
      } catch (e) {
        toast.show({ message: `Failed to init memory: ${e}`, variant: "error" })
      }
    }
    if (!router()) {
      const r = await MemoryStore.getRouter()
      setRouter(r)
    }
  }

  createEffect(() => {
    if (!initDone()) {
      void ensureInit()
    }
  })

  const refreshSnapshot = async () => {
    try {
      await MemoryStore.load()
      setSnapshotRev((r) => r + 1)
    } catch (e) {
      toast.show({ message: `Failed to refresh: ${e}`, variant: "error" })
    }
  }

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

  const openSupermemorySetup = async () => {
    const cfg = await Config.getGlobal()
    const memCfg = (cfg as any).memory ?? {}
    const smCfg = memCfg.backends?.supermemory ?? {}

    dialog.replace(() => (
      <DialogPrompt
        title="Supermemory API Key"
        placeholder="sm_... (or leave blank to use SUPERMEMORY_API_KEY env var)"
        value={smCfg.api_key || ""}
        onConfirm={async (apiKey) => {
          const next = {
            ...cfg,
            memory: {
              ...memCfg,
              backends: {
                ...memCfg.backends,
                supermemory: {
                  ...smCfg,
                  enabled: true,
                  api_key: apiKey || undefined,
                },
              },
            },
          }
          await Config.updateGlobal(next)
          toast.show({ message: "Supermemory configured. Testing connection...", variant: "info" })

          try {
            // @ts-ignore optional dependency
            const { default: Supermemory } = await import("supermemory")
            const key = apiKey || process.env.SUPERMEMORY_API_KEY
            if (!key) throw new Error("No API key provided")
            const client = new Supermemory({ apiKey: key })
            // Test with a lightweight search call
            await client.search.documents({ q: "handofai-test", containerTags: ["handofai-test"] })
            toast.show({ message: "Supermemory connection successful!", variant: "success" })
          } catch {
            toast.show({ message: "Supermemory connection failed. Check your API key.", variant: "error" })
          }
          dialog.clear()
        }}
      />
    ))
  }

  const openGraphlitSetup = async () => {
    const cfg = await Config.getGlobal()
    const memCfg = (cfg as any).memory ?? {}
    const glCfg = memCfg.backends?.graphlit ?? {}

    let collected: { org?: string; env?: string; secret?: string } = {}

    const showOrgPrompt = () => {
      dialog.replace(() => (
        <DialogPrompt
          title="Step 1/3: Graphlit Organization ID"
          placeholder="org_..."
          value={glCfg.organization_id || ""}
          onConfirm={async (orgId) => {
            collected.org = orgId
            setTimeout(showEnvPrompt, 50)
          }}
        />
      ))
    }

    const showEnvPrompt = () => {
      dialog.replace(() => (
        <DialogPrompt
          title="Step 2/3: Graphlit Environment ID"
          placeholder="env_..."
          value={glCfg.environment_id || ""}
          onConfirm={async (envId) => {
            collected.env = envId
            setTimeout(showSecretPrompt, 50)
          }}
        />
      ))
    }

    const showSecretPrompt = () => {
      dialog.replace(() => (
        <DialogPrompt
          title="Step 3/3: Graphlit JWT Secret"
          placeholder="secret..."
          value={glCfg.jwt_secret || ""}
          onConfirm={async (secret) => {
            collected.secret = secret
            const next = {
              ...cfg,
              memory: {
                ...memCfg,
                backends: {
                  ...memCfg.backends,
                  graphlit: {
                    ...glCfg,
                    enabled: true,
                    organization_id: collected.org || undefined,
                    environment_id: collected.env || undefined,
                    jwt_secret: collected.secret || undefined,
                  },
                },
              },
            }
            await Config.updateGlobal(next)
            toast.show({ message: "Graphlit configured. Testing connection...", variant: "info" })

            try {
              // @ts-ignore optional dependency
              const { Graphlit } = await import("graphlit-client")
              const client = new Graphlit({
                organizationId: collected.org,
                environmentId: collected.env,
                jwtSecret: collected.secret,
              })
              await client.querySpecifications({})
              toast.show({ message: "Graphlit connection successful!", variant: "success" })
            } catch {
              toast.show({ message: "Graphlit connection failed. Check your credentials.", variant: "error" })
            }
            dialog.clear()
          }}
        />
      ))
    }

    showOrgPrompt()
  }

  const openSaveBehaviorToggle = async () => {
    const cfg = await Config.getGlobal()
    const memCfg = (cfg as any).memory ?? {}
    const current = memCfg.save_behavior || "smart"

    dialog.replace(() => (
      <DialogSelect
        title="Save Behavior"
        options={[
          {
            title: "Smart Save",
            description: "Agent decides what's worth remembering based on relevance",
            value: "smart",
            onSelect: async () => {
              await Config.updateGlobal({
                ...cfg,
                memory: { ...memCfg, save_behavior: "smart" },
              })
              toast.show({ message: "Save behavior set to Smart", variant: "success" })
              dialog.clear()
            },
          },
          {
            title: "Save Everything",
            description: "All memory-eligible content goes to all configured backends",
            value: "everything",
            onSelect: async () => {
              await Config.updateGlobal({
                ...cfg,
                memory: { ...memCfg, save_behavior: "everything" },
              })
              toast.show({ message: "Save behavior set to Everything", variant: "success" })
              dialog.clear()
            },
          },
        ]}
      />
    ))
  }

  const openSaveModelPicker = () => {
    dialog.replace(() => <DialogMemoryModel />)
  }

  const openSessionScopeToggle = async () => {
    const cfg = await Config.getGlobal()
    const current = (cfg as any).session_list_scope || "project"

    dialog.replace(() => (
      <DialogSelect
        title="Session List Scope"
        options={[
          {
            title: current === "project" ? "Project (current)" : "Project",
            description: "Show only sessions from the current project (default)",
            value: "project",
            onSelect: async () => {
              await Config.updateGlobal({ ...cfg, session_list_scope: "project" })
              toast.show({ message: "Session scope set to Project", variant: "success" })
              dialog.clear()
            },
          },
          {
            title: current === "global" ? "Global (current)" : "Global",
            description: "Show all sessions across all projects",
            value: "global",
            onSelect: async () => {
              await Config.updateGlobal({ ...cfg, session_list_scope: "global" })
              toast.show({ message: "Session scope set to Global", variant: "success" })
              dialog.clear()
            },
          },
        ]}
      />
    ))
  }

  const openBackendRouting = async () => {
    const cfg = await Config.getGlobal()
    const memCfg = (cfg as any).memory ?? {}
    const sm = memCfg.backends?.supermemory?.use_for ?? []
    const gl = memCfg.backends?.graphlit?.use_for ?? []

    const valid = ["user_preferences", "project_knowledge", "code_patterns", "errors", "conversations", "images", "videos", "audio", "documents"]

    dialog.replace(() => (
      <DialogPrompt
        title="Backend Routing"
        placeholder={`Describe how you want backends to handle different content types.\nValid types: ${valid.join(", ")}\n\nSupermemory handles: ${sm.join(", ") || "none"}\nGraphlit handles: ${gl.join(", ") || "none"}`}
        value=""
        onConfirm={async (text) => {
          const lower = text.toLowerCase()
          const smNew: string[] = []
          const glNew: string[] = []

          for (const type of valid) {
            const smMatch = new RegExp(`supermemory.*${type}|${type}.*supermemory`, "i").test(lower)
            const glMatch = new RegExp(`graphlit.*${type}|${type}.*graphlit`, "i").test(lower)
            if (smMatch) smNew.push(type)
            if (glMatch) glNew.push(type)
          }

          // Default: keep existing if no match
          const smFinal = smNew.length > 0 ? smNew : sm
          const glFinal = glNew.length > 0 ? glNew : gl

          await Config.updateGlobal({
            ...cfg,
            memory: {
              ...memCfg,
              backends: {
                ...memCfg.backends,
                supermemory: {
                  ...memCfg.backends?.supermemory,
                  use_for: smFinal,
                },
                graphlit: {
                  ...memCfg.backends?.graphlit,
                  use_for: glFinal,
                },
              },
            },
          })

          toast.show({
            message: `Routing updated: Supermemory={{${smFinal.join(", ")}}}, Graphlit={{${glFinal.join(", ")}}}`,
            variant: "success",
          })
          dialog.clear()
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

    const backendStatus = router()?.status() ?? []
    const smStatus = backendStatus.find((b) => b.id === "supermemory")
    const glStatus = backendStatus.find((b) => b.id === "graphlit")

    return [
      {
        title: `MEMORY.md  ${memEntries.length} entries`,
        description: memStatus,
        value: "memory-edit",
        category: "Local Memory",
        onSelect: async () => {
          openMemoryEdit("MEMORY.md", "memory")
        },
      },
      {
        title: `USER.md  ${usrEntries.length} entries`,
        description: userStatus,
        value: "user-edit",
        category: "Local Memory",
        onSelect: async () => {
          openMemoryEdit("USER.md", "user")
        },
      },
      {
        title: "Search Sessions",
        description: "Search past sessions with FTS5",
        value: "search",
        category: "Search",
        onSelect: async () => {
          openSessionSearch()
        },
      },
      {
        title: "Recent Sessions",
        description: "List recent sessions",
        value: "sessions",
        category: "Search",
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
        title: smStatus?.configured ? "Supermemory Configured" : "Setup Supermemory",
        description: smStatus?.configured ? "Vector memory with semantic search" : "Add API key to enable",
        value: "supermemory-setup",
        category: "Cloud Backends",
        onSelect: async () => {
          await openSupermemorySetup()
        },
      },
      {
        title: glStatus?.configured ? "Graphlit Configured" : "Setup Graphlit",
        description: glStatus?.configured ? "Knowledge graph with RAG" : "Add credentials to enable",
        value: "graphlit-setup",
        category: "Cloud Backends",
        onSelect: async () => {
          await openGraphlitSetup()
        },
      },
      {
        title: "Clear Memory",
        description: "Clear all MEMORY.md entries",
        value: "clear",
        category: "Local Memory",
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
        category: "Local Memory",
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
        category: "Settings",
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
                backends: memCfg.backends ?? {},
                save_behavior: memCfg.save_behavior ?? "smart",
                save_prompt: memCfg.save_prompt,
              },
            })
            toast.show({ message: `Memory ${next ? "enabled" : "disabled"}`, variant: "success" })
          } catch (e) {
            toast.show({ message: `Error: ${e}`, variant: "error" })
          }
          dialog.clear()
        },
      },
      {
        title: "Save Behavior",
        description: "Smart vs Everything",
        value: "save-behavior",
        category: "Settings",
        onSelect: async () => {
          await openSaveBehaviorToggle()
        },
      },
      {
        title: "Backend Routing",
        description: "Customize which backends handle which content types",
        value: "backend-routing",
        category: "Settings",
        onSelect: async () => {
          await openBackendRouting()
        },
      },
      {
        title: "Memory Save Model",
        description: "Model used for auto-save extraction",
        value: "save-model",
        category: "Settings",
        onSelect: async () => {
          await openSaveModelPicker()
        },
      },
      {
        title: "Session List Scope",
        description: "Default scope for /sessions",
        value: "session-scope",
        category: "Settings",
        onSelect: async () => {
          await openSessionScopeToggle()
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
