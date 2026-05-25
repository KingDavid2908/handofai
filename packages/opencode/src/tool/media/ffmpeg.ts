import { Log } from "@/util/log"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"

const log = Log.create({ service: "media.ffmpeg" })

export function detectFfmpeg(): boolean {
  try {
    const result = Bun.spawnSync(["ffmpeg", "-version"], { stdio: ["ignore", "ignore", "ignore"] })
    return result.success
  } catch {
    return false
  }
}

export async function convert(
  input: string,
  output: string,
  options: string[] = [],
): Promise<void> {
  if (!detectFfmpeg()) {
    throw new Error(
      "ffmpeg not found in PATH. Install ffmpeg to use media conversion features.",
    )
  }

  log.info("converting", { input, output })
  await Process.run(
    ["ffmpeg", "-y", "-i", input, ...options, output],
    { timeout: 300_000 },
  )
}

export async function extractAudio(input: string, output: string): Promise<void> {
  await convert(input, output, ["-vn", "-acodec", "copy"])
}

export async function getMediaInfo(
  filepath: string,
): Promise<{ duration?: number; width?: number; height?: number; fps?: number }> {
  if (!detectFfmpeg()) return {}

  try {
    const result = await Process.run(
      [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate,duration",
        "-of",
        "json",
        filepath,
      ],
      { timeout: 30_000 },
    )
    const data = JSON.parse(result.stdout.toString()) as {
      streams?: Array<{
        width?: number
        height?: number
        r_frame_rate?: string
        duration?: string
      }>
    }
    const s = data.streams?.[0]
    if (!s) return {}

    const fpsStr = s.r_frame_rate ?? ""
    const [num, den] = fpsStr.split("/").map(Number)
    const fps = den ? num / den : num

    return {
      width: s.width,
      height: s.height,
      fps: Number.isFinite(fps) ? fps : undefined,
      duration: s.duration ? parseFloat(s.duration) : undefined,
    }
  } catch {
    return {}
  }
}
