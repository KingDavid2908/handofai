import { createMemo, createSignal } from "solid-js"
import { useSync } from "@tui/context/sync"
import { map, pipe, flatMap, entries, filter, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { Config } from "@/config/config"
import * as fuzzysort from "fuzzysort"

type MemoryModelValue = { providerID: string; modelID: string } | null

export function DialogMemoryModel() {
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const [query, setQuery] = createSignal("")

  const cfg = createMemo(() => sync.data.config)
  const current = createMemo<MemoryModelValue>(() => {
    const mem = (cfg() as any)?.memory
    if (!mem?.save_model || mem.save_model.auto) return null
    if (mem.save_model.provider_id && mem.save_model.model_id) {
      return { providerID: mem.save_model.provider_id, modelID: mem.save_model.model_id }
    }
    return null
  })

  const options = createMemo(() => {
    const needle = query().trim()

    const defaultOption = {
      value: null as MemoryModelValue,
      title: "Use session model",
      description: "Uses whatever model the current session is running (default)",
      footer: current() === null ? "Selected" : undefined,
      onSelect: async () => {
        const cur = await Config.getGlobal()
        const memCfg = (cur as any).memory ?? {}
        await Config.updateGlobal({
          ...cur,
          memory: { ...memCfg, save_model: { auto: true } },
        })
        toast.show({ message: "Save model set to session model", variant: "success" })
        dialog.clear()
      },
    }

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (p) => p.id !== "opencode",
        (p) => p.name,
      ),
      flatMap((p) =>
        pipe(
          p.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          map(([modelID, info]) => ({
            value: { providerID: p.id, modelID } as MemoryModelValue,
            title: info.name ?? modelID,
            description: p.name,
            category: p.name,
            footer: info.cost?.input === 0 ? "Free" : undefined,
            onSelect: async () => {
              const cur = await Config.getGlobal()
              const memCfg = (cur as any).memory ?? {}
              await Config.updateGlobal({
                ...cur,
                memory: {
                  ...memCfg,
                  save_model: { auto: false, provider_id: p.id, model_id: modelID },
                },
              })
              toast.show({ message: `Save model set to ${p.name}/${info.name ?? modelID}`, variant: "success" })
              dialog.clear()
            },
          })),
          sortBy(
            (x) => x.footer !== "Free",
            (x) => x.title,
          ),
        ),
      ),
    )

    const allOptions = [defaultOption, ...providerOptions]

    if (needle) {
      return fuzzysort.go(needle, allOptions, { keys: ["title", "category"] }).map((x) => x.obj)
    }

    return allOptions
  })

  return (
    <DialogSelect<MemoryModelValue>
      options={options()}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title="Select memory save model"
      current={current()}
    />
  )
}
