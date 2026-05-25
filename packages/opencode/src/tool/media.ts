import z from "zod"
import path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./media.txt"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import * as Ffmpeg from "./media/ffmpeg"
import * as Registry from "./media/registry"

export const MediaTool = Tool.define("media", async () => {
  const cfg = await Config.getGlobal()
  const mediaCfg = (cfg as any).media ?? {}

  return {
    description: DESCRIPTION,
    parameters: z.object({
      action: z.enum([
        "convert_media",
        "save_space",
        "update_registry",
        "add_category",
        "list_registry",
      ]).describe("Media operation to perform"),
      name: z.string().optional().describe("For save_space: Space ID."),
      source: z.string().optional().describe("Input file path (for convert_media)"),
      output: z.string().optional().describe("Output file path (defaults to current project directory)"),
      options: z.record(z.string(), z.unknown()).optional().describe("Additional operation-specific options"),
    }),
    async execute(params, ctx) {
      const action = params.action
      const outputDir = Instance.directory
      const outputPath = params.output
        ? path.resolve(outputDir, params.output)
        : undefined

      await ctx.ask({
        permission: "media",
        patterns: ["*"],
        always: ["*"],
        metadata: { action, source: params.source, output: outputPath },
      })

      switch (action) {
        case "save_space": {
          const cat = params.options?.category as string | undefined
          const note = params.options?.note as string | undefined
          if (!cat || !params.name) {
            throw new Error("save_space requires 'name' (space ID) and 'options.category'")
          }
          const ok = await Registry.addSpace(cat, params.name, note)
          return {
            title: ok ? "Space saved" : "Space already exists",
            output: ok ? `Saved ${params.name} to ${cat}` : `${params.name} already in ${cat}`,
            metadata: {},
          }
        }

        case "update_registry": {
          const hfToken = mediaCfg.hf_token || process.env.HF_TOKEN
          const { updated, categories } = await Registry.update(hfToken)
          return {
            title: "Registry updated",
            output: `Updated ${updated} categories: ${categories.join(", ") || "none"}`,
            metadata: {},
          }
        }

        case "add_category": {
          if (!params.name) throw new Error("add_category requires 'name'")
          const ok = await Registry.addCategory(params.name)
          return {
            title: ok ? "Category added" : "Category already exists",
            output: ok ? `Created category: ${params.name}` : `Category ${params.name} already exists`,
            metadata: {},
          }
        }

        case "list_registry": {
          const summary = await Registry.getSummary()
          return {
            title: "Media Registry",
            output: summary,
            metadata: {},
          }
        }

        case "convert_media": {
          if (!params.source) {
            throw new Error("source is required for convert_media")
          }
          if (!Ffmpeg.detectFfmpeg()) {
            throw new Error(
              "ffmpeg not found in PATH. Install ffmpeg to use media conversion."
            )
          }
          const inputFile = path.resolve(outputDir, params.source)
          const ext = path.extname(params.source)
          const base = path.basename(params.source, ext)
          const outFile = outputPath || path.join(outputDir, `${base}-converted${ext || ".mp4"}`)
          const opts = Array.isArray(params.options) ? params.options : []
          await Ffmpeg.convert(inputFile, outFile, opts)
          return {
            title: "Converted",
            output: `Converted to: ${outFile}`,
            metadata: {},
          }
        }

        default:
          throw new Error(`Unknown media action: ${action}`)
      }
    },
  }
})
