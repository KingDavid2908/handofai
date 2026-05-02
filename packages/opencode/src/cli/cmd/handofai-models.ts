import type { Argv } from "yargs"
import { Instance } from "../../project/instance"
import { Provider } from "../../provider/provider"
import { Config } from "../../config/config"
import { ModelsDev } from "../../provider/models"
import { ProviderAuth } from "../../provider/auth"
import { ProviderID } from "../../provider/schema"
import { mapValues } from "remeda"
import { cmd } from "./cmd"

export const HandOfAIModelsCommand = cmd({
  command: "handofai-models",
  describe: "list all available models for HandOfAI integration (JSON output)",
  builder: (yargs: Argv) => {
    return yargs.option("json", {
      describe: "output as JSON for programmatic consumption",
      type: "boolean",
      default: true,
    })
  },
  handler: async (args) => {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        // Get all providers from models.dev
        const allProviders = await ModelsDev.get()
        
        // Get connected providers (authenticated)
        const connected = await Provider.list()
        
        // Get auth methods for each provider
        const authMethods = await ProviderAuth.methods()
        
        // Filter and format providers
        const config = await Config.get()
        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
        
        const filteredProviders: Record<string, any> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
            filteredProviders[key] = value
          }
        }
        
        // Merge models.dev providers with connected providers
        const providers = Object.assign(
          mapValues(filteredProviders, (x) => Provider.fromModelsDevProvider(x)),
          connected
        )
        
        // Format output for t3code consumption
        const result = {
          all: Object.values(providers).map((provider: any) => ({
            id: provider.id,
            name: provider.name,
            api: provider.api,
            npm: provider.npm,
            env: provider.env || [],
            models: mapValues(provider.models, (model: any) => ({
              id: model.id,
              name: model.name,
              family: model.family,
              providerID: model.providerID || provider.id,
              cost: model.cost,
              limit: model.limit,
              attachment: model.attachment,
              reasoning: model.reasoning,
              temperature: model.temperature,
              tool_call: model.tool_call,
              modalities: model.modalities,
              status: model.status,
              variants: model.variants,
            })),
          })),
          connected: Object.keys(connected),
          default: mapValues(providers, (item: any) => 
            Provider.sort(Object.values(item.models))[0]?.id
          ),
          auth: authMethods,
        }
        
        if (args.json) {
          process.stdout.write(JSON.stringify(result, null, 2))
        } else {
          // Human-readable format
          for (const provider of result.all) {
            process.stdout.write(`${provider.name} (${provider.id})\n`)
            const sortedModels = Object.entries(provider.models).sort(([a], [b]) => 
              a.localeCompare(b)
            )
            for (const [modelID, model] of sortedModels) {
              const cost = (model as any).cost 
                ? `$${(model as any).cost.input}/${(model as any).cost.output}` 
                : "N/A"
              const isConnected = result.connected.includes(provider.id)
              const status = isConnected ? "✓" : "○"
              process.stdout.write(`  ${status} ${modelID} - ${(model as any).name} (${cost})\n`)
            }
            process.stdout.write("\n")
          }
        }
      },
    })
  },
})
