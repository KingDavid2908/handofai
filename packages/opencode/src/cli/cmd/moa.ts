import type { Argv } from "yargs"
import path from "path"
import { Global } from "../../global"
import { Filesystem } from "../../util/filesystem"
import { Provider } from "../../provider/provider"
import { UI } from "../ui"
import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"

const STATE_FILE = path.join(Global.Path.state, "model.json")

async function readState(): Promise<any> {
  return Filesystem.readJson(STATE_FILE).catch(() => ({}))
}

async function writeState(data: any): Promise<void> {
  const existing = await readState()
  await Filesystem.writeJson(STATE_FILE, {
    ...existing,
    moa_reference_models: data.reference_models ?? existing.moa_reference_models,
    moa_aggregator_model: data.aggregator_model ?? existing.moa_aggregator_model,
  })
}

function modelStr(m: { providerID: string; modelID: string; variant?: string }): string {
  return `${m.providerID}/${m.modelID}${m.variant ? `/${m.variant}` : ""}`
}

export const MoaCommand = cmd({
  command: "moa [action]",
  describe: "configure mixture-of-agents models",
  builder: (yargs: Argv) => {
    return yargs
      .positional("action", {
        describe: "Action: configure, show, reset",
        type: "string",
      })
      .option("reference", {
        alias: "r",
        describe: "Reference model to add (provider/model)",
        type: "string",
        array: true,
      })
      .option("aggregator", {
        alias: "a",
        describe: "Aggregator model (provider/model)",
        type: "string",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const action = args.action ?? "show"

      if (action === "show") {
        const state = await readState()
        const refs = state?.moa_reference_models ?? []
        const agg = state?.moa_aggregator_model

        UI.println(UI.Style.TEXT_NORMAL_BOLD + "Mixture of Agents Configuration:" + UI.Style.TEXT_NORMAL)
        UI.println("")

        if (refs.length > 0) {
          UI.println(UI.Style.TEXT_NORMAL_BOLD + "Reference Models:" + UI.Style.TEXT_NORMAL)
          refs.forEach((m: any, i: number) => {
            UI.println(`  ${i + 1}. ${modelStr(m)}`)
          })
        } else {
          UI.println(UI.Style.TEXT_NORMAL_BOLD + "Reference Models:" + UI.Style.TEXT_NORMAL + " Not configured")
        }

        UI.println("")
        if (agg) {
          UI.println(UI.Style.TEXT_NORMAL_BOLD + "Aggregator Model:" + UI.Style.TEXT_NORMAL + ` ${modelStr(agg)}`)
        } else {
          UI.println(UI.Style.TEXT_NORMAL_BOLD + "Aggregator Model:" + UI.Style.TEXT_NORMAL + " Not configured")
        }
        return
      }

      if (action === "reset") {
        await writeState({ reference_models: [], aggregator_model: null })
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + "MoA configuration reset" + UI.Style.TEXT_NORMAL)
        return
      }

      if (action === "configure" || args.reference || args.aggregator) {
        const state = await readState()
        let refs: any[] = state?.moa_reference_models ?? []
        let agg: any = state?.moa_aggregator_model ?? null

        if (args.reference) {
          const refArgs = Array.isArray(args.reference) ? args.reference : [args.reference]
          for (const ref of refArgs) {
            const parsed = parseModel(ref)
            if (!parsed) {
              UI.error(`Invalid reference model format: ${ref}. Use provider/model`)
              return
            }
            const { providerID, modelID } = parsed
            const valid = await validateModel(providerID, modelID)
            if (!valid) return
            refs.push({ providerID, modelID })
          }
        }

        if (args.aggregator) {
          const parsed = parseModel(args.aggregator)
          if (!parsed) {
            UI.error(`Invalid aggregator model format: ${args.aggregator}. Use provider/model`)
            return
          }
          const { providerID, modelID } = parsed
          const valid = await validateModel(providerID, modelID)
          if (!valid) return
          agg = { providerID, modelID }
        }

        await writeState({ reference_models: refs, aggregator_model: agg })
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + `MoA configured: ${refs.length} reference models + aggregator` + UI.Style.TEXT_NORMAL)
        return
      }

      UI.error(`Unknown action: ${action}. Use: configure, show, reset`)
    })
  },
})

function parseModel(input: string): { providerID: string; modelID: string } | null {
  const slashIndex = input.indexOf("/")
  if (slashIndex === -1) return null
  return {
    providerID: input.slice(0, slashIndex),
    modelID: input.slice(slashIndex + 1),
  }
}

async function validateModel(providerID: string, modelID: string): Promise<boolean> {
  const providers = await Provider.list()
  const provider = Object.values(providers).find((p) => p.id === providerID)
  if (!provider) {
    UI.error(`Provider not found: ${providerID}`)
    return false
  }
  const model = Object.values(provider.models).find((m) => m.id === modelID)
  if (!model) {
    UI.error(`Model not found: ${modelID}`)
    return false
  }
  return true
}
