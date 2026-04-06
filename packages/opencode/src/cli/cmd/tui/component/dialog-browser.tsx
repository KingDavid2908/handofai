import { createSignal, createEffect, createMemo } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useToast } from "@tui/ui/toast"
import { NanoBrowserBridge } from "@/tool/browser/bridge"
import { loadProfiles, getDefaultProfile, setDefaultProfile, type BrowserProfile } from "@/tool/browser/profiles"
import path from "path"

function detectChromePath(): string {
  const paths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]
  for (const p of paths) {
    try {
      if (Bun.file(p).exists()) return p
    } catch {
      continue
    }
  }
  return "chrome"
}

export function DialogBrowser() {
  const dialog = useDialog()
  const toast = useToast()
  const bridge = NanoBrowserBridge.getInstance()

  const [profiles, setProfiles] = createSignal<BrowserProfile[]>([])
  const [defaultId, setDefaultId] = createSignal("")
  const [connected, setConnected] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)

  async function refresh() {
    try {
      const data = await loadProfiles()
      setProfiles(data.profiles)
      setDefaultId(data.defaultProfileId)
    } catch {
      setProfiles([])
      setDefaultId("")
    }
    setConnected(bridge.isConnected())
    setLoaded(true)
  }

  createEffect(() => {
    refresh()

    const onConnected = () => { setConnected(true) }
    const onDisconnected = () => { setConnected(false) }

    bridge.on("connected", onConnected)
    bridge.on("disconnected", onDisconnected)

    return () => {
      bridge.off("connected", onConnected)
      bridge.off("disconnected", onDisconnected)
    }
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (!loaded()) return []

    const profileList = profiles()
    const defId = defaultId()
    const defProfile = profileList.find(p => p.id === defId)
    const isConn = connected()

    return [
      {
        title: `Browser Status`,
        description: isConn ? "NanoBrowser connected" : "NanoBrowser not connected",
        value: "status",
        category: "Browser",
      },
      {
        title: `Default: ${defProfile?.name ?? "None"}`,
        description: "Current default browser profile",
        value: "default",
        category: "Profile",
      },
      ...profileList.map(profile => ({
        title: `${profile.name}${profile.id === defId ? " (default)" : ""}`,
        description: `Chrome: ${profile.chromePath} | Extension: ${profile.extensionLoaded ? "Loaded" : "Not loaded"}`,
        value: `profile:${profile.id}`,
        category: "Profiles",
        onSelect: async () => {
          try {
            await setDefaultProfile(profile.id)
            await refresh()
            toast.show({ message: `Default set to ${profile.name}`, variant: "success" })
            dialog.clear()
          } catch (e) {
            toast.show({ message: `Error: ${e}`, variant: "error" })
          }
        },
      })),
      {
        title: "Setup Extension",
        description: "Open chrome://extensions with instructions",
        value: "setup",
        category: "Setup",
        onSelect: async () => {
          try {
            const chromePath = detectChromePath()
            await Bun.spawn([chromePath, "chrome://extensions"])
            toast.show({
              message: "Chrome opened. Enable Developer mode -> Load unpacked -> select NanoBrowser dist folder",
              variant: "info",
            })
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
      title="Browser"
      placeholder="Search browser actions..."
      options={options()}
    />
  )
}
