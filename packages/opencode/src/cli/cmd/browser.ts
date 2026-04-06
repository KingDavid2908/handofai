import type { Argv } from "yargs"
import path from "path"
import fs from "fs"
import { addProfile } from "../../tool/browser/profiles"
import { NanoBrowserBridge } from "../../tool/browser/bridge"
import { UI } from "../ui"
import { cmd } from "./cmd"

export const BrowserCommand = cmd({
  command: "browser [action]",
  describe: "manage browser automation via NanoBrowser",
  builder: (yargs: Argv) => {
    return yargs
      .positional("action", {
        describe: "Action: setup",
        type: "string",
      })
      .option("name", {
        alias: "n",
        describe: "Profile name for setup",
        type: "string",
      })
  },
  handler: async (args) => {
    const action = args.action ?? "setup"
    if (action === "setup") {
      await browserSetup({ name: args.name })
    } else {
      UI.println(UI.Style.TEXT_NORMAL + `Unknown action: ${action}. Use 'handofaicli browser setup'.`)
    }
  },
})

async function browserSetup(args: { name?: string }) {
  console.log("Browser Extension Setup")
  console.log("═══════════════════════")
  console.log()

  const distPath = getDistPath()
  if (!fs.existsSync(distPath)) {
    console.log("  Extension not found. Please rebuild from the development environment first.")
    console.log(`  Expected: ${distPath}`)
    process.exit(1)
  }

  const chromePath = await detectChrome()

  // Initialize the bridge (will become owner or connect to existing owner)
  console.log("Step 1: Initializing bridge...")
  const bridge = NanoBrowserBridge.getInstance()

  let port: number
  try {
    port = await bridge.start()
    if (bridge.isOwner()) {
      console.log(`  Started as bridge owner on port ${port}`)
    } else {
      console.log(`  Connected to existing bridge on port ${port}`)
    }
  } catch {
    console.log("  Failed to initialize bridge on port 18889")
    process.exit(1)
  }
  console.log()

  // Step 2: Open Chrome
  console.log("Step 2: Opening Chrome...")
  await Bun.spawn([chromePath]).exited
  console.log()

  // Step 3: Guide the user to load the extension
  console.log("Step 3: Load the extension in Chrome")
  console.log("  In Chrome, do the following:")
  console.log("  1. Type chrome://extensions in the address bar and press Enter")
  console.log("  2. Enable 'Developer mode' toggle (top right)")
  console.log("  3. Click 'Load unpacked'")
  console.log(`  4. Select: ${distPath}`)
  console.log()

  // Step 4: Wait for extension to connect (only if we're the owner)
  if (bridge.isOwner()) {
    console.log("Waiting for NanoBrowser to connect (60s timeout)...")
    try {
      await waitForConnection(bridge, 60000)
      console.log("  NanoBrowser connected!")
    } catch {
      console.log()
      console.log("  ERROR: NanoBrowser did not connect within 60 seconds.")
      console.log("  This means the extension failed to load in Chrome.")
      console.log()
      console.log("  Troubleshooting:")
      console.log("  1. In Chrome, go to chrome://extensions")
      console.log("  2. Click 'Errors' on the NanoBrowser card to see details")
      console.log("  3. Fix any errors, then click 'Reload' on the extension card")
      console.log("  4. Run 'handofaicli browser setup' again")
      process.exit(1)
    }

    // Step 5: Save profile (only if owner)
    const profileName = args.name ?? "Personal"
    try {
      await addProfile({
        name: profileName,
        chromePath,
        extensionLoaded: bridge.isConnected(),
      })
      console.log(`  Profile "${profileName}" saved as default`)
    } catch (e) {
      if (String(e).includes("already exists")) {
        console.log(`  Profile "${profileName}" already exists (skipped)`)
      } else {
        console.log(`  Warning: could not save profile: ${e}`)
      }
    }
  } else {
    console.log("  Bridge is owned by another handofaicli process.")
    console.log("  Extension should already be connected to the owner.")
    console.log("  You can verify by pressing / and selecting 'Browser' — it should show 'connected'.")
  }

  console.log("\n═══════════════════════")
  console.log("Browser automation is ready!")
  console.log("  Extension runs in your existing Chrome profile")
  console.log("  All your cookies and logins are available")
  console.log("  Use the browser tool to automate web tasks")
}

async function isPortInUse(port: number): Promise<boolean> {
  try {
    const conn = await Bun.connect({ hostname: "localhost", port })
    conn.close()
    return true
  } catch {
    return false
  }
}

async function detectChrome() {
  const paths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]

  for (const p of paths) {
    try {
      const proc = Bun.spawn([p, "--version"])
      await proc.exited
      if (proc.exitCode === 0) return p
    } catch {
      continue
    }
  }
  return "chrome"
}

async function waitForConnection(bridge, timeout) {
  const start = Date.now()
  while (!bridge.isConnected()) {
    if (Date.now() - start > timeout) {
      throw new Error("NanoBrowser did not connect within timeout")
    }
    await new Promise(r => setTimeout(r, 500))
  }
}

function getDistPath() {
  const exeDir = path.dirname(process.execPath)
  const bundledDist = path.join(exeDir, "nanobrowser-dist")
  if (fs.existsSync(path.join(bundledDist, "manifest.json"))) return bundledDist
  const devDist = path.resolve(__dirname, "../../../../nanobrowser/dist")
  if (fs.existsSync(path.join(devDist, "manifest.json"))) return devDist
  return path.resolve(__dirname, "nanobrowser-dist")
}
