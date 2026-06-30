import { createSignal, Show, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { Spinner } from "../component/spinner"
import { ProviderID } from "@/provider/schema"
import { enrichModels } from "@/provider/model-enrich"
import { Log } from "../../../../util/log"
import { Config } from "@/config/config"

interface OpenAIModel {
  id: string
  object: string
  created?: number
  owned_by?: string
}

export function DialogOpenAICompatible() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()
  const toast = useToast()
  const [step, setStep] = createSignal<"name" | "baseURL" | "apiKey" | "fetching" | "models" | "enriching">("name")
  const [providerName, setProviderName] = createSignal("")
  const [baseURL, setBaseURL] = createSignal("https://api.openai.com/v1")
  const [apiKey, setApiKey] = createSignal("")
  const [models, setModels] = createSignal<OpenAIModel[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [started, setStarted] = createSignal(false)

  const promptProviderName = async () => {
    const value = await new Promise<string | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogPrompt
            title="Provider Name"
            placeholder="e.g., ollama-local, lm-studio"
            onConfirm={(value) => resolve(value)}
          />
        ),
        () => resolve(null),
      )
    })
    if (!value) return null
    setProviderName(value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""))
    return value
  }

  const promptBaseURL = async () => {
    const value = await new Promise<string | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogPrompt
            title="Base URL"
            placeholder="https://api.openai.com/v1"
            value={baseURL()}
            description={() => (
              <text fg={theme.textMuted}>
                OpenAI API endpoint (default: https://api.openai.com/v1)
              </text>
            )}
            onConfirm={(value) => resolve(value || "https://api.openai.com/v1")}
          />
        ),
        () => resolve(null),
      )
    })
    if (!value) return null
    setBaseURL(value)
    return value
  }

  const promptApiKey = async () => {
    const value = await new Promise<string | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogPrompt title="API Key" placeholder="sk-..." onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (!value) return null
    setApiKey(value)
    return value
  }

  const fetchModels = async () => {
    const url = baseURL().replace(/\/+$/, "")
    const key = apiKey()
    try {
      const response = await fetch(`${url}/models`, {
        headers: { Authorization: `Bearer ${key}` },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      const data = await response.json()
      const modelList = (data.data || data.models || [])
        .filter((m: OpenAIModel) => m.id)
        .map((m: OpenAIModel) => ({
          id: m.id,
          object: m.object || "model",
          created: m.created,
          owned_by: m.owned_by,
        }))
      setModels(modelList)
      return modelList
    } catch (e) {
      setError(String(e))
      return null
    }
  }

  const saveAndConnect = async (selectedModel: string) => {
    const providerID = `${providerName()}:${selectedModel}`
    const normalizedBaseURL = baseURL().replace(/\/+$/, "")
    const modelConfig: Record<string, any> = {}
    for (const m of models()) {
      modelConfig[m.id] = {
        id: m.id,
        tool_call: true,
        limit: { context: 128000, output: 16384 },
        provider: { npm: "@ai-sdk/openai-compatible", api: normalizedBaseURL },
      }
    }

    await sdk.client.auth.set({
      providerID,
      auth: { type: "api", key: apiKey() },
    })

    const res = await sdk.client.global.config.update({
      config: {
        provider: {
          [providerName()]: {
            npm: "@ai-sdk/openai-compatible",
            name: providerName(),
            api: normalizedBaseURL,
            options: { baseURL: normalizedBaseURL },
            models: modelConfig,
          },
        },
      },
    })
    if (res.error) {
      const detail = res.error?.errors?.[0] ?? res.error?.data
      toast.show({
        variant: "error",
        message: `Failed to save config: ${detail ? JSON.stringify(detail).slice(0, 200) : "unknown error"}`,
        duration: 5000,
      })
      dialog.clear()
      return
    }

    await sdk.client.instance.dispose()
    await sync.bootstrap()
    local.model.set({ providerID, modelID: selectedModel }, { recent: true })

    setStep("enriching")

    try {
      const modelRecord = Object.fromEntries(models().map((m) => [m.id, { id: m.id }]))
      const enrichedModels = await enrichModels(modelRecord)
      if (Object.keys(enrichedModels).length > 0) {
        await Config.updateGlobal({
          provider: {
            [providerName()]: {
              models: enrichedModels,
            },
          },
        })
      }
    } catch (e) {
      Log.create({ service: "model-enrich" }).warn("enrichment failed", { error: e })
    }

    dialog.clear()
  }

  onMount(async () => {
    if (started()) return
    setStarted(true)

    const name = await promptProviderName()
    if (!name) {
      dialog.clear()
      return
    }

    const url = await promptBaseURL()
    if (!url) {
      dialog.clear()
      return
    }

    const key = await promptApiKey()
    if (!key) {
      dialog.clear()
      return
    }

    setStep("fetching")

    const modelList = await fetchModels()
    if (!modelList || modelList.length === 0) {
      if (error()) {
        toast.show({
          variant: "error",
          message: `Failed to fetch models: ${error()}`,
          duration: 5000,
        })
      }
      dialog.clear()
      return
    }

    setStep("models")

    const modelOptions = modelList.map((m: OpenAIModel) => ({
      title: m.id,
      value: m.id,
      description: m.owned_by || undefined,
    }))

    const selected = await new Promise<string | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title="Select Model"
            options={modelOptions}
            onSelect={(option) => resolve(option.value as string)}
          />
        ),
        () => resolve(null),
      )
    })

    if (selected) {
      await saveAndConnect(selected)
    } else {
      dialog.clear()
    }
  })

  return (
    <box gap={1} paddingBottom={1}>
      <Show when={step() === "fetching"}>
        <box paddingLeft={4} paddingRight={4} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text}>Fetching models</text>
            <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
              esc
            </text>
          </box>
          <Spinner color={theme.textMuted}>Connecting to {baseURL()}</Spinner>
        </box>
      </Show>
      <Show when={step() === "enriching"}>
        <box paddingLeft={4} paddingRight={4} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text}> enriching metadata</text>
            <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
              esc
            </text>
          </box>
          <Spinner color={theme.textMuted}>Querying OpenRouter API</Spinner>
        </box>
      </Show>
    </box>
  )
}