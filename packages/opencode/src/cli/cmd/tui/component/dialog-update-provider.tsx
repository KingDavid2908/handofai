import { createSignal, onMount, Show } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { Spinner } from "./spinner"
import { useTheme } from "../context/theme"
import { Config } from "@/config/config"
import { enrichModels } from "@/provider/model-enrich"
import { useToast } from "../ui/toast"

export function DialogUpdateProvider() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()
  const [step, setStep] = createSignal<"select" | "enriching">("select")
  const [providers, setProviders] = createSignal<any[]>([])

  onMount(async () => {
    const allProviders = sync.data.provider.filter(
      (p) => p.source === "config",
    ).map((p) => ({
      id: p.id,
      name: p.name,
      models: Object.keys(p.models ?? {}).length,
    }))
    setProviders(allProviders)
  })

  const onSelect = async (providerId: string) => {
    const provider = sync.data.provider.find((p) => p.id === providerId)
    if (!provider?.models) return

    setStep("enriching")

    try {
      const enriched = await enrichModels(provider.models)
      if (Object.keys(enriched).length > 0) {
        await Config.updateGlobal({
          provider: {
            [providerId]: {
              models: enriched,
            },
          },
        })
      }
      toast.show({ variant: "info", message: `Updated ${Object.keys(enriched).length} models`, duration: 3000 })
    } catch (e) {
      toast.show({ variant: "error", message: "Enrichment failed", duration: 3000 })
    }

    dialog.clear()
  }

  return (
    <box gap={1}>
      <Show when={step() === "select"}>
        <DialogSelect
          title="Update Provider Metadata"
          options={providers().map((p) => ({
            title: `${p.name}`,
            value: p.id,
            description: `${p.models} models • ${p.id}`,
          }))}
          onSelect={(opt) => onSelect(opt.value as string)}
        />
      </Show>
      <Show when={step() === "enriching"}>
        <box paddingLeft={4} paddingRight={4} gap={1}>
          <text fg={theme.text}>Updating metadata</text>
          <Spinner color={theme.textMuted}>Querying OpenRouter API</Spinner>
        </box>
      </Show>
    </box>
  )
}