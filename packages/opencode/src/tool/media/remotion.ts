import { Global } from "@/global"
import { Log } from "@/util/log"
import { Filesystem } from "@/util/filesystem"
import { BunProc } from "@/bun"
import { Lock } from "@/util/lock"
import { Flock } from "@/util/flock"
import { rmSync } from "fs"
import path from "path"

const log = Log.create({ service: "media.remotion" })

const WORKSPACE = path.join(Global.Path.data, "remotion")

const PKG_JSON = JSON.stringify(
  {
    name: "handofai-remotion",
    version: "1.0.0",
    dependencies: {
      remotion: "latest",
      "@remotion/cli": "latest",
      react: "^18.3.1",
      "react-dom": "^18.3.1",
    },
    devDependencies: {
      typescript: "^5.5.0",
      "@types/react": "^18.3.12",
      "@types/react-dom": "^18.3.1",
    },
  },
  null,
  2,
)

const TS_CONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2018",
      module: "commonjs",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      lib: ["es2015"],
    },
    include: ["src/**/*"],
    exclude: ["remotion.config.ts"],
  },
  null,
  2,
)

const INDEX_TSX = `import { registerRoot } from "remotion"
import { RemotionRoot } from "./Root"

registerRoot(RemotionRoot)
`

const REMOTION_CONFIG = `import { Config } from "@remotion/cli/config"

Config.setVideoImageFormat("jpeg")
Config.setOverwriteOutput(true)
`

const ROOT_TSX = `import { Composition } from "remotion"
import { BlankComposition } from "./templates/blank"

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="Blank"
        component={BlankComposition}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ text: "Hello World" }}
      />
    </>
  )
}
`

const BLANK_TSX = `import { AbsoluteFill, useCurrentFrame } from "remotion"

export const BlankComposition = ({ text }: { text: string }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        fontSize: 100,
        backgroundColor: "white",
      }}
    >
      {text} — frame {frame}
    </AbsoluteFill>
  )
}
`

export interface CompInfo {
  id: string
  width: number
  height: number
  fps: number
  durationInFrames: number
}

export async function ensureWorkspace(): Promise<string> {
  const pkgPath = path.join(WORKSPACE, "package.json")
  const exists = await Filesystem.exists(pkgPath)

  if (exists) {
    // Detect old workspace config and migrate
    const pkgRaw = await Filesystem.readText(pkgPath).catch(() => "{}")
    const isOld = pkgRaw.includes('"type": "module"') || pkgRaw.includes("@remotion/bundler")
    const indexPath = path.join(WORKSPACE, "src", "index.tsx")
    const hasIndex = await Filesystem.exists(indexPath)
    const tsConfigPath = path.join(WORKSPACE, "tsconfig.json")
    const tsRaw = await Filesystem.readText(tsConfigPath).catch(() => "{}")
    const isOldTs = tsRaw.includes('"module": "NodeNext"')

    if (isOld || !hasIndex || isOldTs) {
      log.info("migrating old remotion workspace", { path: WORKSPACE })
      rmSync(WORKSPACE, { recursive: true, force: true })
      // Fall through to create fresh workspace
    } else {
      return WORKSPACE
    }
  }

  log.info("creating workspace", { path: WORKSPACE })

  await Filesystem.write(path.join(WORKSPACE, "package.json"), PKG_JSON)
  await Filesystem.write(path.join(WORKSPACE, "tsconfig.json"), TS_CONFIG)
  await Filesystem.write(path.join(WORKSPACE, "remotion.config.ts"), REMOTION_CONFIG)
  await Filesystem.write(path.join(WORKSPACE, "src", "index.tsx"), INDEX_TSX)
  await Filesystem.write(path.join(WORKSPACE, "src", "Root.tsx"), ROOT_TSX)
  await Filesystem.write(path.join(WORKSPACE, "src", "templates", "blank.tsx"), BLANK_TSX)

  return WORKSPACE
}

export async function installDeps(workspace: string): Promise<void> {
  const lockKey = `remotion-install:${workspace}`
  await using _ = await Flock.acquire(lockKey, { timeoutMs: 120_000 })

  const remotionPkg = path.join(workspace, "node_modules", "@remotion", "cli", "package.json")
  if (await Filesystem.exists(remotionPkg)) {
    log.info("deps already installed")
    return
  }

  log.info("installing deps", { workspace })
  await BunProc.run(["install"], { cwd: workspace, timeout: 300_000 })
  log.info("deps installed")
}

export async function addComposition(
  workspace: string,
  name: string,
  code: string,
): Promise<void> {
  const templatesDir = path.join(workspace, "src", "templates")
  const filePath = path.join(templatesDir, `${name}.tsx`)
  await Filesystem.write(filePath, code)

  const rootPath = path.join(workspace, "src", "Root.tsx")
  let root = await Filesystem.readText(rootPath)

  const importLine = `import { ${toPascalCase(name)} } from "./templates/${name}"`
  if (!root.includes(importLine)) {
    root = root.replace(
      "export const RemotionRoot",
      `${importLine}\n\nexport const RemotionRoot`,
    )
  }

  const compLine = `<Composition\n        id="${toPascalCase(name)}"\n        component={${toPascalCase(name)}}\n        durationInFrames={150}\n        fps={30}\n        width={1920}\n        height={1080}\n      />`
  if (!root.includes(`id="${toPascalCase(name)}"`)) {
    root = root.replace(
      "</>",
      `  ${compLine}\n    </>`,
    )
  }

  await Filesystem.write(rootPath, root)
}

function toPascalCase(str: string): string {
  return str
    .replace(/[-_]/g, " ")
    .replace(/(?:^|\\s)\\w/g, (m) => m.toUpperCase())
    .replace(/\\s/g, "")
}

const activeStudio: { proc?: ReturnType<typeof Bun.spawn>; url: string } = { url: "http://localhost:3000" }

async function killPort3000() {
  try {
    if (process.platform === "win32") {
      const { stdout } = Bun.spawnSync(["cmd", "/c", "netstat -ano | findstr :3000 | findstr LISTENING"], { stdout: "pipe" })
      const lines = stdout.toString().split("\n").filter(Boolean)
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        const pid = parts[parts.length - 1]
        if (pid && pid !== "0") {
          log.info("killing process on port 3000", { pid })
          Bun.spawnSync(["taskkill", "/PID", pid, "/F"], { stdio: "ignore" })
        }
      }
    } else {
      const { stdout } = Bun.spawnSync(["lsof", "-ti:3000"], { stdout: "pipe" })
      const pids = stdout.toString().trim().split("\n").filter(Boolean)
      for (const pid of pids) {
        log.info("killing process on port 3000", { pid })
        Bun.spawnSync(["kill", "-9", pid.trim()], { stdio: "ignore" })
      }
    }
  } catch {
    // port is free, nothing to kill
  }
}

export async function openStudio(workspace: string): Promise<string> {
  const url = activeStudio.url
  const logFile = path.join(Global.Path.log, "remotion-studio.log")
  log.info("starting studio", { workspace, url, logFile })

  await killPort3000()

  if (activeStudio.proc) {
    try { activeStudio.proc.kill() } catch {}
    activeStudio.proc = undefined
    await sleep(1_000)
  }

  activeStudio.proc = Bun.spawn(
    [BunProc.which(), "x", "remotionb", "studio", "src/index.tsx", "--port", "3000", "--no-open"],
    {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  const writer = Bun.file(logFile).writer()
  async function pipe(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await writer.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const out = activeStudio.proc.stdout
  const err = activeStudio.proc.stderr
  if (out && typeof out !== "number") pipe(out)
  if (err && typeof err !== "number") pipe(err)

  await sleep(3_000)
  if (activeStudio.proc.exitCode !== null) {
    const errorLog = await Bun.file(logFile).text().catch(() => "")
    throw new Error(
      `Remotion Studio exited with code ${activeStudio.proc.exitCode}${
        errorLog ? `\nLog:\n${errorLog.slice(0, 2000)}` : ""
      }`,
    )
  }

  let ready = false
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (resp.ok || resp.status === 404) {
        ready = true
        break
      }
    } catch {
      // not ready yet
    }
  }

  if (!ready) {
    const errorLog = await Bun.file(logFile).text().catch(() => "")
    throw new Error(
      `Remotion Studio failed to start within 60 seconds${
        errorLog ? `\nLog:\n${errorLog.slice(0, 2000)}` : ""
      }`,
    )
  }

  return url
}

export async function render(
  workspace: string,
  composition: string,
  output: string,
): Promise<void> {
  log.info("rendering", { workspace, composition, output })
  await BunProc.run(
    ["x", "remotionb", "render", "src/index.tsx", composition, output],
    { cwd: workspace, timeout: 600_000 },
  )
  log.info("render complete", { output })
}

export async function closeStudio(): Promise<void> {
  log.info("closing studio")
  if (activeStudio.proc) {
    try { activeStudio.proc.kill() } catch {}
    activeStudio.proc = undefined
  }
  try { await killPort3000() } catch {}
}

export async function restartStudio(workspace: string): Promise<string> {
  await closeStudio()
  return openStudio(workspace)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
