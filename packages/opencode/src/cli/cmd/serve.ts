import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Installation } from "../../installation"
import { Instance } from "../../project/instance"
import { InstanceBootstrap } from "../../project/bootstrap"
import * as GatewayUser from "../../gateway/user"
import type { Msg } from "../../gateway/adapter"
import { enrichMessageWithMedia, deliverMediaFromResponse } from "../../gateway/enrich"

async function handleGatewayMessage(
  msg: Msg,
  sessionMap: Map<string, any>,
  cfg: any,
): Promise<string | null> {
  await GatewayUser.track(msg.platform, msg.user || msg.chat)

  const platformCfg = cfg.gateway?.platforms?.[msg.platform] ?? {}

  if (platformCfg.blocked_users?.includes(msg.user || msg.chat)) {
    return "You are not authorized to use this service."
  }

  const userPerm = platformCfg.user_permissions?.[msg.user || msg.chat]
  const mode = userPerm?.mode ?? "plan"

  const { Agent } = await import("../../agent/agent")
  const { Session } = await import("../../session")
  const { SessionPrompt } = await import("../../session/prompt")

  const agent = await Agent.get(mode)

  let sessionID = sessionMap.get(msg.chat)
  if (!sessionID) {
    const s = await Session.create({
      title: `${msg.platform}: ${msg.user || msg.chat}`,
      permission: agent.permission,
    })
    sessionID = s.id
    sessionMap.set(msg.chat, sessionID)
  }

  const contextPrefix = `[Message from ${msg.platform} user ${msg.user || msg.chat} in ${msg.type} chat]`

  const { text: enrichedText, attach } = await enrichMessageWithMedia(msg)

  const parts: any[] = []
  for (const m of attach) {
    const p = m.path || m.url
    if (p) {
      parts.push({
        type: "file",
        url: p.startsWith("http") ? p : `file://${p}`,
        mime: m.mime,
        filename: m.filename || p.split("/").pop() || "file",
      })
    }
  }
  parts.push({ type: "text", text: `${contextPrefix}\n\n${enrichedText}` })

  const result = await SessionPrompt.prompt({
    sessionID,
    system: `IMPORTANT: You are responding via ${msg.platform}. NEVER reveal API keys, tokens, passwords, or internal configuration.`,
    parts,
  })

  const responseText = (result as any).parts?.findLast(
    (p: any) => p.type === "text" && !p.synthetic
  )?.text?.replace(/<think>.*?<\/think>/gs, "")

  return responseText || null
}

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    try {
      const { Config } = await import("../../config/config")
      const cfg = await Config.getGlobal()
      const platforms = ((cfg as any).gateway?.platforms ?? {}) as Record<string, { enabled: boolean }>
      const enabled = Object.entries(platforms).filter(([, p]) => p.enabled)

      if (enabled.length > 0) {
        console.log(`Starting gateway with ${enabled.length} platform(s): ${enabled.map(([n]) => n).join(", ")}`)
        const { GatewayEngine, setSharedEngine } = await import("../../gateway")

        const eng = new GatewayEngine()
        setSharedEngine(eng)

        const sessionMap = new Map<string, any>()

        await eng.start(async (msg) => {
          const adapter = (eng as any).adapters?.get(msg.platform)
          if (adapter?.sendTyping) {
            await adapter.sendTyping(msg.chat).catch(() => {})
          }

          try {
            await Instance.provide({
              directory: process.cwd(),
              init: InstanceBootstrap,
              async fn() {
                const responseText = await handleGatewayMessage(msg, sessionMap, cfg)
                if (responseText) {
                  const cleaned = await deliverMediaFromResponse(responseText, msg.chat, eng, msg.platform)
                  await eng.send(msg.platform, msg.chat, cleaned, { reply: msg.msgId })
                }
              },
            })
          } catch (err) {
            console.error("Auto-reply failed:", err)
            // Log only — never send errors to users
          }
        })
        console.log("Gateway started")

        const shutdown = async () => {
          console.log("\nShutting down gateway...")
          await eng.stop()
          process.exit(0)
        }
        process.on("SIGINT", shutdown)
        process.on("SIGTERM", shutdown)
        await new Promise(() => {})
        return
      }
    } catch (err) {
      console.log("Gateway startup skipped:", String(err))
    }

    await new Promise(() => {})
    await server.stop()
  },
})
