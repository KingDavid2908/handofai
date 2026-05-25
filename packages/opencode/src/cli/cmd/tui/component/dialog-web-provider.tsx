import { createMemo, createSignal, createEffect } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { Config } from "@/config/config"
import { useToast } from "@tui/ui/toast"
import { DialogPrompt } from "../ui/dialog-prompt"
import { getRouter, type WebRouter, WebProvider } from "@/tool/web-provider"

function desc(id: string): string {
  const map: Record<string, string> = {
    exa: "Exa",
    tinyfish: "TinyFish",
    tavily: "Tavily",
    direct: "Direct Fetch",
    firecrawl: "Firecrawl",
  }
  return map[id] || id
}

export function DialogWebProvider() {
  const dialog = useDialog()
  const toast = useToast()
  const [router, setRouter] = createSignal<WebRouter | null>(null)
  const [initDone, setInitDone] = createSignal(false)

  const ensureInit = async () => {
    try {
      const r = await getRouter()
      setRouter(r)
      setInitDone(true)
    } catch (e) {
      toast.show({ message: `Failed to init web providers: ${e}`, variant: "error" })
    }
  }

  createEffect(() => {
    if (!initDone()) void ensureInit()
  })

  const reinit = async () => {
    const fresh = await getRouter()
    setRouter(null)
    setRouter(fresh)
  }

  // --- mirrors openSupermemorySetup exactly ---

  const openApiKeySetup = async (provider: string, isSearch: boolean) => {
    const cfg = await Config.getGlobal()
    const web = (cfg as any).web ?? {}
    const target = isSearch ? "search" : "fetch"
    const keys = web[target]?.api_keys ?? {}
    const current = keys[provider] || ""

    dialog.replace(() => (
      <DialogPrompt
        title={`${desc(provider)} API Key`}
        placeholder={`API key (or leave blank to use ${provider.toUpperCase()}_API_KEY env var)`}
        value={current}
        onConfirm={async (key) => {
          const envVar = `${provider.toUpperCase()}_API_KEY`
          const resolved = key || process.env[envVar] || ""

          const next = {
            ...cfg,
            web: {
              ...web,
              [target]: {
                ...web[target],
                api_keys: {
                  ...web[target]?.api_keys,
                  [provider]: resolved || undefined,
                },
              },
            },
          }
          await Config.updateGlobal(next as any)

          if (!resolved) {
            toast.show({ message: `Please set ${envVar} env var or provide an API key`, variant: "error" })
            dialog.clear()
            return
          }

          toast.show({ message: `${desc(provider)} configured. Testing connection...`, variant: "info" })

          try {
            switch (provider) {
              case "tinyfish": {
                // @ts-ignore optional dependency
                const { TinyFish } = await import("@tiny-fish/sdk")
                const client = new TinyFish({ apiKey: resolved })
                await client.search.query({ query: "test" })
                break
              }
              case "tavily": {
                const res = await fetch("https://api.tavily.com/search", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${resolved}`,
                  },
                  body: JSON.stringify({ query: "test", max_results: 1 }),
                })
                if (!res.ok) {
                  const data = await res.json().catch(() => ({}))
                  throw new Error(data.detail?.error || `${res.status} ${res.statusText}`)
                }
                break
              }
              case "firecrawl": {
                const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${resolved}`,
                  },
                  body: JSON.stringify({ url: "https://example.com", formats: ["markdown"] }),
                })
                if (!res.ok) {
                  const data = await res.json().catch(() => ({}))
                  throw new Error(data.error || `${res.status} ${res.statusText}`)
                }
                break
              }
            }
            toast.show({ message: `${desc(provider)} connection successful!`, variant: "success" })
            await reinit()
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            toast.show({
              message: `${desc(provider)} connection failed: ${msg}`,
              variant: "error",
            })
          }
          dialog.clear()
        }}
      />
    ))
  }

  // --- hierarchy pickers ---

  const openSearchHierarchy = async () => {
    const r = router()
    const available = r?.getAvailableSearch().map((p) => p.id) ?? []
    if (available.length === 0) {
      toast.show({ message: "No search providers configured. Set up at least one provider first.", variant: "error" })
      return
    }
    showHierarchyStep("Search", available, "search", 0, {})
  }

  const openFetchHierarchy = async () => {
    const r = router()
    const available = r?.getAvailableFetch().map((p) => p.id) ?? []
    if (available.length === 0) {
      toast.show({ message: "No fetch providers configured. Set up at least one provider first.", variant: "error" })
      return
    }
    showHierarchyStep("Fetch", available, "fetch", 0, {})
  }

  const showHierarchyStep = (
    label: string,
    available: string[],
    type: "search" | "fetch",
    step: number,
    selected: { primary?: string; fallback?: string; fallback2?: string },
  ) => {
    const used = [selected.primary, selected.fallback, selected.fallback2].filter(Boolean) as string[]
    const opts = available.filter((p) => !used.includes(p))

    if (opts.length === 0) {
      finishHierarchy(type, selected)
      return
    }

    const titles = ["Primary", "Fallback", "Fallback of Fallback"]
    const stepLabel = titles[step] || titles[2]

    dialog.replace(() => (
      <DialogSelect
        title={`${label} Hierarchy — ${stepLabel}`}
        options={opts.map((p) => ({
          title: desc(p),
          value: p,
          onSelect: async () => {
            const next = { ...selected }
            if (step === 0) next.primary = p
            else if (step === 1) next.fallback = p
            else next.fallback2 = p

            if (step + 1 >= 3 || opts.length <= 1) {
              await finishHierarchy(type, next)
            } else {
              showHierarchyStep(label, available, type, step + 1, next)
            }
          },
        }))}
      />
    ))
  }

  const finishHierarchy = async (
    type: "search" | "fetch",
    selected: { primary?: string; fallback?: string; fallback2?: string },
  ) => {
    const state = await WebProvider.readState()
    state[type] = {
      primary: selected.primary,
      fallback: selected.fallback || undefined,
      fallback2: selected.fallback2 || undefined,
    }
    await WebProvider.writeState(state)

    const chain = [selected.primary, selected.fallback, selected.fallback2]
      .filter(Boolean)
      .map((p) => desc(p!))
      .join(" → ")

    toast.show({ message: `${type === "search" ? "Search" : "Fetch"} hierarchy set: ${chain}`, variant: "success" })
    dialog.clear()
  }

  // --- test all ---

  const openTestAll = async () => {
    const ids = ["tinyfish", "tavily", "firecrawl"]
    const r = router()
    const results: string[] = []

    for (const id of ids) {
      const p = r?.get(id)
      if (!p || !p.configured) continue

      try {
        const key = await WebProvider.getApiKey(id)
        if (!key) continue

        const result = await p.testConnection(key)
        if (result.success) {
          results.push(`${desc(id)}: OK`)
        } else {
          results.push(`${desc(id)}: ${result.error}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push(`${desc(id)}: ${msg}`)
      }
    }

    if (results.length === 0) {
      toast.show({ message: "No external providers configured to test", variant: "info" })
    } else {
      toast.show({ message: `Connection tests:\n${results.join("\n")}`, variant: "info" })
    }

    dialog.clear()
  }

  // --- reset ---

  const openResetDefaults = async () => {
    const state = await WebProvider.readState()
    delete state.search
    delete state.fetch
    await WebProvider.writeState(state)
    toast.show({ message: "Provider hierarchy reset to defaults", variant: "success" })
    dialog.clear()
  }

  // --- options ---

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const status = router()?.status() ?? []
    const tf = status.find((b) => b.id === "tinyfish")
    const tv = status.find((b) => b.id === "tavily")
    const fc = status.find((b) => b.id === "firecrawl")

    const tfLabel = tf?.configured ? "TinyFish — Configured" : "Setup TinyFish"
    const tfDesc = tf?.configured ? "Free tier, geo-targeting" : "Add API key to enable"
    const tvLabel = tv?.configured ? "Tavily — Configured" : "Setup Tavily"
    const tvDesc = tv?.configured ? "AI-optimized search" : "Add API key to enable"
    const fcLabel = fc?.configured ? "Firecrawl — Configured" : "Setup Firecrawl"
    const fcDesc = fc?.configured ? "Structured data extraction" : "Add API key to enable"

    return [
      {
        title: "Exa (Default)",
        description: "Neural search with MCP integration",
        value: "exa",
        category: "Search Providers",
        onSelect: () => dialog.clear(),
      },
      {
        title: `${tfLabel} Search`,
        description: tfDesc,
        value: "tinyfish-search-setup",
        category: "Search Providers",
        onSelect: async () => await openApiKeySetup("tinyfish", true),
      },
      {
        title: tvLabel,
        description: tvDesc,
        value: "tavily-search-setup",
        category: "Search Providers",
        onSelect: async () => await openApiKeySetup("tavily", true),
      },
      {
        title: `${fcLabel} Search`,
        description: fcDesc,
        value: "firecrawl-search-setup",
        category: "Search Providers",
        onSelect: async () => await openApiKeySetup("firecrawl", true),
      },
      {
        title: "Direct Fetch (Default)",
        description: "Raw HTTP fetch with HTML-to-markdown",
        value: "direct",
        category: "Fetch Providers",
        onSelect: () => dialog.clear(),
      },
      {
        title: `${tfLabel} Fetch`,
        description: tfDesc,
        value: "tinyfish-fetch-setup",
        category: "Fetch Providers",
        onSelect: async () => await openApiKeySetup("tinyfish", false),
      },
      {
        title: `${tvLabel} Extract`,
        description: tvDesc,
        value: "tavily-fetch-setup",
        category: "Fetch Providers",
        onSelect: async () => await openApiKeySetup("tavily", false),
      },
      {
        title: fcLabel,
        description: fcDesc,
        value: "firecrawl-fetch-setup",
        category: "Fetch Providers",
        onSelect: async () => await openApiKeySetup("firecrawl", false),
      },
      {
        title: "Set Search Priority",
        description: "Primary → fallback order",
        value: "search-hierarchy",
        category: "Search Hierarchy",
        onSelect: async () => await openSearchHierarchy(),
      },
      {
        title: "Set Fetch Priority",
        description: "Primary → fallback order",
        value: "fetch-hierarchy",
        category: "Fetch Hierarchy",
        onSelect: async () => await openFetchHierarchy(),
      },
      {
        title: "Test All Connections",
        description: "Check configured providers",
        value: "test-all",
        category: "Settings",
        onSelect: async () => await openTestAll(),
      },
      {
        title: "Reset to Defaults",
        description: "Clear hierarchy and use config defaults",
        value: "reset",
        category: "Settings",
        onSelect: async () => await openResetDefaults(),
      },
    ]
  })

  return (
    <DialogSelect
      title="Web Providers"
      placeholder="Search web provider actions..."
      options={options()}
    />
  )
}
