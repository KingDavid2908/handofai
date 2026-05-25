import { cmd } from "./cmd"
import { UI } from "../ui"
import * as Remotion from "@/tool/media/remotion"
import * as Ffmpeg from "@/tool/media/ffmpeg"
import { Config } from "@/config/config"
import { Log } from "@/util/log"

const log = Log.create({ service: "cmd.media" })

export const MediaCommand = cmd({
  command: "media <action> [input]",
  describe: "Create, edit, generate, and convert media files",
  builder: (yargs) =>
    yargs
      .command("setup-hf-token <token>", "Save Hugging Face token to config", (y) =>
        y.positional("token", { type: "string", describe: "HF API token (hf_...)" }),
      )
      .positional("action", {
        type: "string",
        choices: [
          "create-video",
          "render-video",
          "list-compositions",
          "studio",
          "convert",
          "setup",
          "setup-hf-token",
        ],
        describe: "Media operation to perform",
      })
      .positional("input", {
        type: "string",
        describe: "Input file path (for editing/conversion)",
      })
      .option("output", {
        type: "string",
        alias: "o",
        describe: "Output file path",
      })
      .option("prompt", {
        type: "string",
        alias: "p",
        describe: "Text prompt for generation tasks",
      })
      .option("name", {
        type: "string",
        alias: "n",
        describe: "Composition name for video tasks",
      }),
  handler: async (args) => {
    const action = args.action

    try {
      switch (action) {
        case "setup-hf-token": {
          const token = args.input || args.token || ""
          if (!token) {
            UI.println(UI.Style.TEXT_WARNING + "Token required. Usage: handofaicli media setup-hf-token <token>" + UI.Style.TEXT_NORMAL)
            return
          }
          const cfg = await Config.getGlobal()
          const mediaCfg = (cfg as any).media ?? {}
          await Config.updateGlobal({
            ...cfg,
            media: { ...mediaCfg, hf_token: token },
          })
          UI.println(UI.Style.TEXT_SUCCESS_BOLD + "HF token saved" + UI.Style.TEXT_NORMAL)
          break
        }

        case "setup": {
          const workspace = await Remotion.ensureWorkspace()
          await Remotion.installDeps(workspace)
          UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Media workspace ready" + UI.Style.TEXT_NORMAL)
          break
        }

        case "create-video": {
          const workspace = await Remotion.ensureWorkspace()
          await Remotion.installDeps(workspace)
          const name = args.name || "NewVideo"
          const code = args.prompt || "// Add your video code here"
          await Remotion.addComposition(workspace, name, code)
          UI.println(`Created composition: ${name}`)
          break
        }

        case "list-compositions": {
          const workspace = await Remotion.ensureWorkspace()
          const rootPath = await import("path").then((p) => p.join(workspace, "src", "Root.tsx"))
          const fs = await import("fs/promises")
          const rootContent = await fs.readFile(rootPath, "utf-8").catch(() => "")
          const ids = [...rootContent.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
          if (ids.length === 0) {
            UI.println("No compositions found")
          } else {
            ids.forEach((id) => UI.println(`  - ${id}`))
          }
          break
        }

        case "studio": {
          const workspace = await Remotion.ensureWorkspace()
          await Remotion.installDeps(workspace)
          const url = await Remotion.openStudio(workspace)
          UI.println(`Remotion Studio: ${url}`)
          break
        }

        case "convert": {
          if (!args.input) {
            UI.println(UI.Style.TEXT_WARNING + "Input file required" + UI.Style.TEXT_NORMAL)
            return
          }
          if (!Ffmpeg.detectFfmpeg()) {
            UI.println(UI.Style.TEXT_WARNING + "ffmpeg not found in PATH" + UI.Style.TEXT_NORMAL)
            return
          }
          const out = args.output || `converted-${Date.now()}.mp4`
          await Ffmpeg.convert(args.input, out)
          UI.println(`Converted: ${out}`)
          break
        }

        default:
          UI.println(`Unknown action: ${action}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      UI.println(UI.Style.TEXT_WARNING + `Error: ${msg}` + UI.Style.TEXT_NORMAL)
      log.error("media command failed", { action, error: msg })
    }
  },
})
