import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import { useKeybind } from "../context/keybind"
import * as fuzzysort from "fuzzysort"
import { useToast } from "@tui/ui/toast"
import type { DialogSelectOption } from "@tui/ui/dialog-select"

type MoaModel = { providerID: string; modelID: string; variant?: string }
type Step = "reference" | "aggregator"

export function DialogMoaConfig() {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const toast = useToast()
  const [query, setQuery] = createSignal("")
  const [step, setStep] = createSignal<Step>("reference")
  const [selectedModels, setSelectedModels] = createSignal<MoaModel[]>([])

  const connected = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const providers = createDialogProviderOptions()

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = connected() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((x) => x.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect: () => onSelect(provider.id, model.id),
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

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
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? "(Favorite)"
              : undefined,
            category: connected() ? provider.name : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect() {
              onSelect(provider.id, model)
            },
          })),
          filter((x) => {
            if (!showSections) return true
            if (favorites.some((item) => item.providerID === x.value.providerID && item.modelID === x.value.modelID))
              return false
            if (recents.some((item) => item.providerID === x.value.providerID && item.modelID === x.value.modelID))
              return false
            return true
          }),
          sortBy(
            (x) => x.footer !== "Free",
            (x) => x.title,
          ),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const title = createMemo(() => {
    const s = step()
    const count = selectedModels().length
    return s === "reference"
      ? `Select reference model ${count + 1} (${count}/5)`
      : "Select aggregator model"
  })

  function onSelect(providerID: string, modelID: string) {
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      completeSelection(providerID, modelID, undefined)
      return
    }
    if (list.length > 0) {
      dialog.replace(() => (
        <DialogVariantMoa
          providerID={providerID}
          modelID={modelID}
          onConfirm={(variant) => completeSelection(providerID, modelID, variant)}
          onCancel={() => dialog.replace(() => <DialogMoaConfigInner selected={selectedModels()} step={step()} />)}
        />
      ))
      return
    }
    completeSelection(providerID, modelID, undefined)
  }

  function completeSelection(providerID: string, modelID: string, variant: string | undefined) {
    const model: MoaModel = { providerID, modelID, variant }
    const current = selectedModels()
    const next = [...current, model]
    setSelectedModels(next)

    if (step() === "reference") {
      if (next.length >= 5) {
        setStep("aggregator")
        dialog.replace(() => <DialogMoaConfigInner selected={next} step="aggregator" />)
        return
      }
      dialog.replace(() => <DialogMoaConfigInner selected={next} step="reference" />)
    }
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      keybind={[
        {
          keybind: keybind.all.model_provider_list?.[0],
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        ...(step() === "reference" && selectedModels().length >= 2
          ? [
              {
                keybind: keybind.all.model_list?.[0]!,
                title: "Finish reference selection",
                onTrigger() {
                  setStep("aggregator")
                  dialog.replace(() => <DialogMoaConfigInner selected={selectedModels()} step="aggregator" />)
                },
              },
            ]
          : []),
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

function DialogMoaConfigInner(props: { selected: MoaModel[]; step: Step }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const toast = useToast()
  const [query, setQuery] = createSignal("")

  const connected = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const providers = createDialogProviderOptions()

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = connected() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((x) => x.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect: () => onSelect(provider.id, model.id),
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

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
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? "(Favorite)"
              : undefined,
            category: connected() ? provider.name : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect() {
              onSelect(provider.id, model)
            },
          })),
          filter((x) => {
            if (!showSections) return true
            if (favorites.some((item) => item.providerID === x.value.providerID && item.modelID === x.value.modelID))
              return false
            if (recents.some((item) => item.providerID === x.value.providerID && item.modelID === x.value.modelID))
              return false
            return true
          }),
          sortBy(
            (x) => x.footer !== "Free",
            (x) => x.title,
          ),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const title = createMemo(() => {
    const s = props.step
    const count = props.selected.length
    return s === "reference"
      ? `Select reference model ${count + 1} (${count}/5)`
      : "Select aggregator model"
  })

  function onSelect(providerID: string, modelID: string) {
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      completeSelection(providerID, modelID, undefined)
      return
    }
    if (list.length > 0) {
      dialog.replace(() => (
        <DialogVariantMoa
          providerID={providerID}
          modelID={modelID}
          onConfirm={(variant) => completeSelection(providerID, modelID, variant)}
          onCancel={() => dialog.replace(() => <DialogMoaConfigInner selected={props.selected} step={props.step} />)}
        />
      ))
      return
    }
    completeSelection(providerID, modelID, undefined)
  }

  function completeSelection(providerID: string, modelID: string, variant: string | undefined) {
    const model: MoaModel = { providerID, modelID, variant }
    if (props.step === "reference") {
      const next = [...props.selected, model]
      if (next.length >= 5) {
        dialog.replace(() => <DialogMoaConfigInner selected={next} step="aggregator" />)
        return
      }
      dialog.replace(() => <DialogMoaConfigInner selected={next} step="reference" />)
    } else {
      local.moa.setReferenceModels(props.selected)
      local.moa.setAggregatorModel(model)
      toast.show({
        message: `MoA configured: ${props.selected.length} reference models + aggregator`,
        variant: "success",
        duration: 3000,
      })
      dialog.clear()
    }
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      keybind={[
        {
          keybind: keybind.all.model_provider_list?.[0],
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        ...(props.step === "reference" && props.selected.length >= 2
          ? [
              {
                keybind: keybind.all.model_list?.[0]!,
                title: "Finish reference selection",
                onTrigger() {
                  dialog.replace(() => <DialogMoaConfigInner selected={props.selected} step="aggregator" />)
                },
              },
            ]
          : []),
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

function DialogVariantMoa(props: { providerID: string; modelID: string; onConfirm: (variant: string | undefined) => void; onCancel: () => void }) {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() => {
    return [
      {
        value: "default",
        title: "Default",
        onSelect: () => {
          props.onConfirm(undefined)
        },
      },
      ...local.model.variant.list().map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () => {
          props.onConfirm(variant)
        },
      })),
    ]
  })

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select variant"}
      current={local.model.variant.selected()}
      flat={true}
    />
  )
}
