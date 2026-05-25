import { createMemo, createSignal } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { Config } from "@/config/config"
import { useToast } from "@tui/ui/toast"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import * as HfSpaces from "@/tool/media/hf-spaces"
import * as Remotion from "@/tool/media/remotion"
import * as Ffmpeg from "@/tool/media/ffmpeg"
import * as Registry from "@/tool/media/registry"
import { Filesystem } from "@/util/filesystem"
import path from "path"

export function DialogMedia() {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [loading, setLoading] = createSignal<string | null>(null)

  const openHfTokenSetup = async () => {
    const cfg = await Config.getGlobal()
    const mediaCfg = (cfg as any).media ?? {}
    const current = mediaCfg.hf_token || ""

    dialog.replace(() => (
      <DialogPrompt
        title="Hugging Face Token Setup"
        placeholder="hf_... (create a Read token at huggingface.co/settings/tokens)"
        value={current}
        onConfirm={async (token) => {
          const resolved = token || process.env.HF_TOKEN || ""

          const next = {
            ...cfg,
            media: {
              ...mediaCfg,
              hf_token: resolved || undefined,
            },
          }
          await Config.updateGlobal(next)

          if (!resolved) {
            toast.show({ message: "Please set HF_TOKEN env var or provide a token", variant: "error" })
            dialog.clear()
            return
          }

          toast.show({ message: "Testing HF connection...", variant: "info" })

          try {
            const spaces = await HfSpaces.searchForSpace("test", resolved)
            if (spaces.length > 0) {
              toast.show({ message: "Hugging Face connection successful!", variant: "success" })
            } else {
              toast.show({ message: "Connected but no spaces found", variant: "warning" })
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            toast.show({ message: `HF connection failed: ${msg}`, variant: "error" })
          }
          dialog.clear()
        }}
      />
    ))
  }

  const openRemotionSetup = async () => {
    setLoading("setup")
    try {
      const workspace = await Remotion.ensureWorkspace()
      await Remotion.installDeps(workspace)
      toast.show({ message: "Remotion workspace ready", variant: "success" })
    } catch (e) {
      toast.show({ message: `Setup failed: ${e}`, variant: "error" })
    }
    setLoading(null)
    dialog.clear()
  }

  const openStudio = async () => {
    setLoading("studio")
    try {
      const workspace = await Remotion.ensureWorkspace()
      await Remotion.installDeps(workspace)
      const url = await Remotion.openStudio(workspace)
      setLoading(null)

      dialog.replace(() => (
        <box paddingLeft={2} paddingRight={2} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              Remotion Studio
            </text>
            <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
              esc
            </text>
          </box>
          <box gap={1} paddingBottom={1}>
            <text fg={theme.text}>Studio is running at:</text>
            <Link href={url} fg={theme.primary}>
              {url}
            </Link>
            <text fg={theme.textMuted}>Click the link to open in your browser</text>
          </box>
        </box>
      ))
    } catch (e) {
      setLoading(null)
      toast.show({ message: `Failed: ${e}`, variant: "error" })
      dialog.clear()
    }
  }

  const openAutoUpdateSettings = async () => {
    const cfg = await Config.getGlobal()
    const token = (cfg as any).media?.hf_token || process.env.HF_TOKEN

    dialog.replace(() => (
      <DialogSelect
        title="Auto-Update Settings"
        placeholder="Choose update mode..."
        options={[
          { title: "Manual (default)", value: "manual", onSelect: async () => {
            await Registry.updateSettings("manual")
            toast.show({ message: "Update mode set to Manual", variant: "success" })
            dialog.clear()
          }},
          { title: "Daily", value: "daily", onSelect: async () => {
            await Registry.updateSettings("auto", 1)
            toast.show({ message: "Update mode set to Daily", variant: "success" })
            dialog.clear()
          }},
          { title: "Weekly", value: "weekly", onSelect: async () => {
            await Registry.updateSettings("auto", 7)
            toast.show({ message: "Update mode set to Weekly", variant: "success" })
            dialog.clear()
          }},
          { title: "Monthly", value: "monthly", onSelect: async () => {
            await Registry.updateSettings("auto", 30)
            toast.show({ message: "Update mode set to Monthly", variant: "success" })
            dialog.clear()
          }},
          { title: "Custom (days)", value: "custom", onSelect: () => {
            dialog.replace(() => (
              <DialogPrompt
                title="Custom Interval (days)"
                placeholder="Enter number of days..."
                onConfirm={async (days) => {
                  const n = parseInt(days, 10)
                  if (isNaN(n) || n < 1) {
                    toast.show({ message: "Invalid number", variant: "error" })
                    dialog.clear()
                    return
                  }
                  await Registry.updateSettings("auto", n)
                  toast.show({ message: `Update mode set to every ${n} days`, variant: "success" })
                  dialog.clear()
                }}
              />
            ))
          }},
        ]}
      />
    ))
  }

  const openManageCategories = async () => {
    const categories = await Registry.listCategories()

    dialog.replace(() => (
      <DialogSelect
        title="Manage Categories"
        placeholder="Select a category or add new..."
        options={[
          ...categories.map((c) => ({
            title: c,
            value: c,
            onSelect: async () => {
              const spaces = await Registry.listSpaces(c)
              dialog.replace(() => (
                <DialogSelect
                  title={`Category: ${c}`}
                  placeholder="Spaces in this category..."
                  options={[
                    ...spaces.map((s) => ({
                      title: `${s.id} (${s.likes} likes)`,
                      value: s.id,
                      onSelect: () => dialog.clear(),
                    })),
                    {
                      title: "Add Space...",
                      value: "add-space",
                      onSelect: () => {
                        dialog.replace(() => (
                          <DialogPrompt
                            title="Add Space ID"
                            placeholder="owner/space-name"
                            onConfirm={async (spaceId) => {
                              const ok = await Registry.addSpace(c, spaceId)
                              toast.show({ message: ok ? `Added ${spaceId}` : "Already exists", variant: ok ? "success" : "warning" })
                              dialog.clear()
                            }}
                          />
                        ))
                      },
                    },
                    {
                      title: "Remove Space...",
                      value: "remove-space",
                      onSelect: () => {
                        dialog.replace(() => (
                          <DialogPrompt
                            title="Remove Space ID"
                            placeholder="owner/space-name"
                            onConfirm={async (spaceId) => {
                              const ok = await Registry.removeSpace(c, spaceId)
                              toast.show({ message: ok ? `Removed ${spaceId}` : "Not found", variant: ok ? "success" : "warning" })
                              dialog.clear()
                            }}
                          />
                        ))
                      },
                    },
                  ]}
                />
              ))
            },
          })),
          {
            title: "Add New Category...",
            value: "add-category",
            onSelect: () => {
              dialog.replace(() => (
                <DialogPrompt
                  title="New Category Name"
                  placeholder="e.g. audio-to-video"
                  onConfirm={async (name) => {
                    const ok = await Registry.addCategory(name)
                    toast.show({ message: ok ? `Created ${name}` : "Already exists", variant: ok ? "success" : "warning" })
                    dialog.clear()
                  }}
                />
              ))
            },
          },
        ]}
      />
    ))
  }

  const openUpdateRegistry = async () => {
    setLoading("update")
    try {
      const cfg = await Config.getGlobal()
      const token = (cfg as any).media?.hf_token || process.env.HF_TOKEN
      const { updated, categories } = await Registry.update(token)
      toast.show({ message: `Updated ${updated} categories: ${categories.join(", ") || "none"}`, variant: "success" })
    } catch (e) {
      toast.show({ message: `Update failed: ${e}`, variant: "error" })
    }
    setLoading(null)
    dialog.clear()
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => [
    {
      title: "Setup HF Token",
      value: "setup-hf",
      category: "Setup",
      onSelect: openHfTokenSetup,
    },
    {
      title: "Setup Remotion Workspace",
      value: "setup-remotion",
      category: "Setup",
      onSelect: openRemotionSetup,
    },
    {
      title: "Check Dependencies",
      value: "check-deps",
      category: "Setup",
      onSelect: async () => {
        const ffmpeg = Ffmpeg.detectFfmpeg()
        toast.show({
          message: `ffmpeg: ${ffmpeg ? "found" : "NOT FOUND"}`,
          variant: ffmpeg ? "success" : "error",
        })
        dialog.clear()
      },
    },
    {
      title: "Update Registry Now",
      value: "update-registry",
      category: "Registry",
      onSelect: openUpdateRegistry,
    },
    {
      title: "Auto-Update Settings",
      value: "auto-update",
      category: "Registry",
      onSelect: openAutoUpdateSettings,
    },
    {
      title: "Manage Categories",
      value: "manage-categories",
      category: "Registry",
      onSelect: openManageCategories,
    },
    {
      title: "List Compositions",
      value: "list-video",
      category: "Studio",
      onSelect: async () => {
        const workspace = await Remotion.ensureWorkspace()
        const rootPath = path.join(workspace, "src", "Root.tsx")
        const content = await Filesystem.readText(rootPath).catch(() => "")
        const ids = [...content.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
        const msg = ids.length > 0
          ? `Found ${ids.length} composition${ids.length > 1 ? "s" : ""}:\n${ids.map((id, i) => `${i + 1}. ${id}`).join("\n")}`
          : "No compositions found"
        toast.show({ message: msg, variant: ids.length > 0 ? "success" : "info" })
        dialog.clear()
      },
    },
    {
      title: "Open Remotion Studio",
      value: "studio",
      category: "Studio",
      onSelect: openStudio,
    },
    {
      title: "Close Remotion Studio",
      value: "close-studio",
      category: "Studio",
      onSelect: async () => {
        setLoading("close")
        try {
          await Remotion.closeStudio()
          toast.show({ message: "Studio closed", variant: "success" })
        } catch (e) {
          toast.show({ message: `Failed: ${e}`, variant: "error" })
        }
        setLoading(null)
        dialog.clear()
      },
    },
    {
      title: "Restart Remotion Studio",
      value: "restart-studio",
      category: "Studio",
      onSelect: async () => {
        setLoading("studio")
        try {
          const workspace = await Remotion.ensureWorkspace()
          await Remotion.installDeps(workspace)
          const url = await Remotion.restartStudio(workspace)
          setLoading(null)
          toast.show({ message: `Studio restarted at ${url}`, variant: "success" })
        } catch (e) {
          setLoading(null)
          toast.show({ message: `Failed: ${e}`, variant: "error" })
        }
        dialog.clear()
      },
    },
  ])

  return (
    <DialogSelect
      title="Media Setup"
      placeholder="Configure media tools and registry..."
      options={options()}
    />
  )
}
