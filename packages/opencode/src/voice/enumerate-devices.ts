export interface Device {
  idx: number
  name: string
}

export async function listDevices(): Promise<Device[]> {
  if (process.platform !== "win32") return []
  const check = Bun.spawnSync(["ffmpeg", "-version"], { stdio: ["ignore", "ignore", "ignore"] })
  if (!check.success) return []
  try {
    const proc = Bun.spawn(["ffmpeg", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
      stderr: "pipe",
      stdout: "ignore",
    })
    const out = await Bun.readableStreamToText(proc.stderr)
    const lines = out.split("\n")
    const devices: Device[] = []
    let idx = 0
    for (const line of lines) {
      if (line.includes("Alternative name")) continue
      const m = line.match(/"([^"]+)"\s+\(audio\)/)
      if (m) {
        devices.push({ idx: idx++, name: m[1] })
      }
    }
    return devices
  } catch {
    return []
  }
}
