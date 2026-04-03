import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, flatMap, entries, filter, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useKeybind } from "../context/keybind"
import * as fuzzysort from "fuzzysort"

type VisionModelValue = { providerID: string; modelID: string } | null

export function DialogVisionModel() {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const [query, setQuery] = createSignal("")

  const options = createMemo(() => {
    const needle = query().trim()

    const defaultOption = {
      value: null as VisionModelValue,
      title: "Use current model",
      description: "Uses vision capability of current task model",
      footer: local.visionModel.current() === null ? "Default" : undefined,
      onSelect() {
        local.visionModel.clear()
        dialog.clear()
      },
    }

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => info.capabilities.input.image === true),
          map(([modelID, info]) => ({
            value: { providerID: provider.id, modelID } as VisionModelValue,
            title: info.name ?? modelID,
            description: provider.name,
            category: provider.name,
            footer: info.cost?.input === 0 ? "Free" : undefined,
            onSelect() {
              local.visionModel.set({ providerID: provider.id, modelID })
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

  const current = createMemo<VisionModelValue>(() => local.visionModel.current())

  return (
    <DialogSelect<VisionModelValue>
      options={options()}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title="Select vision model"
      current={current()}
    />
  )
}
