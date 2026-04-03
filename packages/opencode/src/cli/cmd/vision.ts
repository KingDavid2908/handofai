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
  await Filesystem.writeJson(STATE_FILE, data)
}

export const VisionCommand = cmd({
  command: "vision [model]",
  describe: "configure your preferred vision model",
  builder: (yargs: Argv) => {
    return yargs.positional("model", {
      describe: "provider/model to use for vision, or 'none' to use current model",
      type: "string",
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      if (!args.model) {
        const state = await readState()
        const vm = state?.visionModel
        if (vm) {
          UI.println(UI.Style.TEXT_NORMAL_BOLD + "Vision model:" + UI.Style.TEXT_NORMAL + ` ${vm.providerID}/${vm.modelID}`)
        } else {
          UI.println(UI.Style.TEXT_NORMAL_BOLD + "Vision model:" + UI.Style.TEXT_NORMAL + " Use current model (default)")
        }
        return
      }

      if (args.model === "none" || args.model === "default" || args.model === "current") {
        const state = await readState()
        delete state.visionModel
        await writeState(state)
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Vision model reset to: Use current model" + UI.Style.TEXT_NORMAL)
        return
      }

      const slashIndex = args.model.indexOf("/")
      if (slashIndex === -1) {
        UI.error("Invalid format. Use: provider/model")
        return
      }

      const providerID = args.model.slice(0, slashIndex)
      const modelID = args.model.slice(slashIndex + 1)

      const providers = await Provider.list()
      const provider = Object.values(providers).find((p) => p.id === providerID)
      if (!provider) {
        UI.error(`Provider not found: ${providerID}`)
        return
      }

      const model = Object.values(provider.models).find((m) => m.id === modelID)
      if (!model) {
        UI.error(`Model not found: ${modelID}`)
        return
      }

      if (!model.capabilities.input.image) {
        UI.error(`Model ${args.model} does not support vision.`)
        return
      }

      const state = await readState()
      state.visionModel = { providerID, modelID }
      await writeState(state)
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Vision model set to: ${args.model}` + UI.Style.TEXT_NORMAL)
    })
  },
})
