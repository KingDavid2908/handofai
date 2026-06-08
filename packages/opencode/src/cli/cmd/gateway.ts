import { Auth } from "../../auth"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { cmd } from "./cmd"
import { Instance } from "../../project/instance"
import { InstanceBootstrap } from "../../project/bootstrap"
import { Process } from "../../util/process"
import * as GatewayUser from "../../gateway/user"
import type { Msg } from "../../gateway/adapter"
import { enrichMessageWithMedia, deliverMediaFromResponse } from "../../gateway/enrich"

const PLATFORMS = [
  { id: "telegram", name: "Telegram", free: true, pkg: false },
  { id: "discord", name: "Discord", free: true, pkg: "discord.js" },
  { id: "whatsapp", name: "WhatsApp (Baileys / unofficial)", free: true, pkg: "@whiskeysockets/baileys" },
  { id: "whatsapp_business", name: "WhatsApp Business API (Meta / official)", free: false, pkg: false },
  { id: "slack", name: "Slack", free: true, pkg: "@slack/web-api @slack/socket-mode" },
  { id: "signal", name: "Signal", free: true, pkg: false },
  { id: "email", name: "Email (SMTP)", free: true, pkg: "nodemailer" },
  { id: "sms", name: "SMS (Twilio)", free: false, pkg: false },
  { id: "matrix", name: "Matrix", free: true, pkg: false },
  { id: "dingtalk", name: "DingTalk", free: true, pkg: false },
  { id: "feishu", name: "Feishu / Lark", free: true, pkg: false },
  { id: "wecom", name: "WeCom (WeChat Work)", free: true, pkg: false },
  { id: "qqbot", name: "QQ Bot", free: true, pkg: false },
  { id: "mattermost", name: "Mattermost", free: true, pkg: false },
  { id: "bluebubbles", name: "iMessage (BlueBubbles)", free: true, pkg: "socket.io-client" },
  { id: "webhook", name: "Webhook", free: true, pkg: false },
  { id: "homeassistant", name: "Home Assistant", free: true, pkg: false },
]

function platformById(id: string) {
  return PLATFORMS.find((p) => p.id === id)
}

async function installPkg(pkg: string) {
  const s = prompts.spinner()
  s.start(`Installing ${pkg}...`)
  try {
    await Process.run(["bun", "add", pkg], {
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    })
    s.stop(`${pkg} installed`)
  } catch {
    s.stop(`Failed to install ${pkg}`, 1)
    throw new Error(`Could not install ${pkg}`)
  }
}

async function validateCred(id: string, key: string, extra: Record<string, string>) {
  switch (id) {
    case "telegram": {
      const r = await fetch(`https://api.telegram.org/bot${key}/getMe`)
      const d = await r.json() as any
      return d.ok ? { ok: true as const, info: `@${d.result.username}` } : { ok: false as const, error: d.description || "Invalid token" }
    }
    case "discord": {
      const r = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bot ${key}` } })
      if (r.ok) { const d = await r.json() as any; return { ok: true as const, info: d.username } }
      return { ok: false as const, error: `${r.status} ${r.statusText}` }
    }
    case "whatsapp": {
      return { ok: true as const, info: "Stored" }
    }
    case "whatsapp_business": {
      const r = await fetch(`https://graph.facebook.com/v22.0/${extra.phone_number_id}`, { headers: { Authorization: `Bearer ${key}` } })
      return r.ok ? { ok: true as const } : { ok: false as const, error: `${r.status}` }
    }
    case "slack": {
      const r = await fetch("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${key}` } })
      const d = await r.json() as any
      return d.ok ? { ok: true as const, info: d.user } : { ok: false as const, error: d.error || "Invalid token" }
    }
    case "signal": {
      const url = (extra.cli_url || "http://127.0.0.1:8080").replace(/\/$/, "")
      const phone = extra.phone || key
      const r = await fetch(`${url}/v1/receive/${phone}`)
      return r.ok ? { ok: true as const } : { ok: false as const, error: "signal-cli not responding" }
    }
    case "email": {
      const nodemailer = await import("nodemailer")
      const transport = nodemailer.createTransport({
        host: extra.smtp_host || "smtp.gmail.com",
        port: parseInt(extra.smtp_port || "587", 10),
        secure: extra.smtp_port === "465",
        auth: { user: extra.username || "", pass: key },
      })
      try { await transport.verify(); return { ok: true as const } } catch (e: any) { return { ok: false as const, error: e.message } }
    }
    case "sms": {
      const [sid, token] = key.split(":")
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) },
      })
      return r.ok ? { ok: true as const } : { ok: false as const, error: `${r.status}` }
    }
    case "matrix": {
      const r = await fetch(`${extra.homeserver_url}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${key}` },
      })
      return r.ok ? { ok: true as const } : { ok: false as const, error: `${r.status}` }
    }
    case "dingtalk": {
      const r = await fetch("https://oapi.dingtalk.com/gettoken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appKey: extra.app_id, appSecret: key }),
      })
      const d = await r.json() as any
      return d.errcode === 0 ? { ok: true as const } : { ok: false as const, error: d.errmsg }
    }
    case "feishu": {
      const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: extra.app_id, app_secret: key }),
      })
      const d = await r.json() as any
      return d.tenant_access_token ? { ok: true as const } : { ok: false as const, error: d.msg }
    }
    case "wecom": {
      const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${extra.corp_id}&corpsecret=${key}`)
      const d = await r.json() as any
      return d.errcode === 0 ? { ok: true as const } : { ok: false as const, error: d.errmsg }
    }
    case "qqbot": {
      const r = await fetch("https://api.sgroup.qq.com/users/@me", { headers: { Authorization: `QQBot ${key}` } })
      return r.ok ? { ok: true as const } : { ok: false as const, error: `${r.status}` }
    }
    case "mattermost": {
      const r = await fetch(`${extra.server_url}/api/v4/users/me`, { headers: { Authorization: `Bearer ${key}` } })
      return r.ok ? { ok: true as const } : { ok: false as const, error: `${r.status}` }
    }
    case "bluebubbles": {
      const r = await fetch(`${extra.server_url}/api/v1/server/info`, { headers: { "Z-API-Key": key } })
      return r.ok ? { ok: true as const } : { ok: false as const, error: `${r.status}` }
    }
    case "webhook": {
      new URL(key)
      return { ok: true as const }
    }
    case "homeassistant": {
      const r = await fetch(`${extra.server_url}/api/config`, { headers: { Authorization: `Bearer ${key}` } })
      return r.ok ? { ok: true as const } : { ok: false as const, error: `${r.status}` }
    }
    default:
      return { ok: true as const }
  }
}

const PROMPTS: Record<string, { label: string; placeholder?: string; key: string; type?: string }[]> = {
  telegram: [{ label: "Bot Token", placeholder: "123456789:ABCdef...", key: "token" }],
  discord: [{ label: "Bot Token", placeholder: "NTE2ODk0...", key: "token" }],
  whatsapp: [{ label: "Phone Number", placeholder: "15551234567", key: "phone" }],
  whatsapp_business: [
    { label: "API Token", placeholder: "EAAx...", key: "token" },
    { label: "Phone Number ID", placeholder: "1234567890", key: "phone_number_id" },
  ],
  slack: [
    { label: "Bot Token (xoxb-...)", placeholder: "xoxb-...", key: "token" },
    { label: "App Token (xapp-...)", placeholder: "xapp-...", key: "app_token" },
  ],
  signal: [
    { label: "Account Phone Number", placeholder: "+15551234567", key: "phone" },
    { label: "signal-cli HTTP URL", placeholder: "http://127.0.0.1:8080", key: "cli_url" },
  ],
  email: [
    { label: "SMTP Host", placeholder: "smtp.gmail.com", key: "smtp_host" },
    { label: "SMTP Port", placeholder: "587", key: "smtp_port" },
    { label: "Username", placeholder: "you@gmail.com", key: "username" },
    { label: "Password / App Password", placeholder: "...", key: "password", type: "password" },
  ],
  sms: [
    { label: "Account SID", placeholder: "ACxxxxxxxx...", key: "sid" },
    { label: "Auth Token", placeholder: "...", key: "token", type: "password" },
    { label: "From Number", placeholder: "+15551234567", key: "from" },
  ],
  matrix: [
    { label: "Homeserver URL", placeholder: "https://matrix.org", key: "homeserver_url" },
    { label: "Access Token", placeholder: "syt_...", key: "token" },
  ],
  dingtalk: [
    { label: "App ID", placeholder: "dingxxx...", key: "app_id" },
    { label: "App Secret", placeholder: "...", key: "app_secret", type: "password" },
  ],
  feishu: [
    { label: "App ID", placeholder: "cli_xxx...", key: "app_id" },
    { label: "App Secret", placeholder: "...", key: "app_secret", type: "password" },
  ],
  wecom: [
    { label: "Corp ID", placeholder: "wwxxx...", key: "corp_id" },
    { label: "Agent ID", placeholder: "1000001", key: "agent_id" },
    { label: "Secret", placeholder: "...", key: "secret", type: "password" },
  ],
  qqbot: [
    { label: "Bot App ID", placeholder: "12345...", key: "app_id" },
    { label: "Bot Token", placeholder: "...", key: "token" },
  ],
  mattermost: [
    { label: "Server URL", placeholder: "https://mattermost.example.com", key: "server_url" },
    { label: "Bot Token", placeholder: "...", key: "token" },
  ],
  bluebubbles: [
    { label: "Server URL", placeholder: "http://mac-mini.local:1234", key: "server_url" },
    { label: "API Key", placeholder: "...", key: "api_key", type: "password" },
  ],
  webhook: [{ label: "Incoming URL", placeholder: "https://hooks.example.com/endpoint", key: "url" }],
  homeassistant: [
    { label: "Server URL", placeholder: "http://homeassistant.local:8123", key: "server_url" },
    { label: "Long-Lived Token", placeholder: "...", key: "token" },
  ],
}

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

export const GatewayCommand = cmd({
  command: "gateway",
  describe: "manage messaging gateway platforms",
  builder: (yargs) =>
    yargs
      .command(GatewayListCommand)
      .command(GatewayLoginCommand)
      .command(GatewayLogoutCommand)
      .command(GatewayStartCommand)
      .command(GatewayStopCommand)
      .command(GatewayStatusCommand)
      .command(GatewayUserListCommand)
      .command(GatewayUserGrantCommand)
      .command(GatewayUserRevokeCommand)
      .command(GatewayUserBlockCommand)
      .command(GatewayUserUnblockCommand)
      .command(GatewayUserInfoCommand)
      .demandCommand(),
  async handler() {},
})

export const GatewayListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list configured messaging platforms",
  async handler() {
    UI.empty()
    prompts.intro("Gateway Platforms")
    const cfg = await Config.getGlobal()
    const gw = (cfg as any).gateway?.platforms ?? {}
    const creds = await Auth.all()

    if (Object.keys(gw).length === 0) {
      prompts.log.info("No platforms configured. Run handofaicli gateway login to add one.")
      prompts.outro("Done")
      return
    }

    for (const [id, pcfg] of Object.entries(gw as Record<string, any>)) {
      const meta = platformById(id)
      const name = meta?.name || id
      const hasCred = !!creds[id]
      const status = pcfg.enabled ? "enabled" : "disabled"
      const credStatus = hasCred ? "authenticated" : "no credentials"
      prompts.log.info(`${name} ${UI.Style.TEXT_DIM}[${status}, ${credStatus}]`)
      if (pcfg.method) prompts.log.info(`  method: ${pcfg.method}`)
      for (const [k, v] of Object.entries(pcfg)) {
        if (k === "enabled" || k === "method") continue
        if (typeof v === "string" && !v.includes("secret") && !v.includes("token") && !v.includes("password")) {
          prompts.log.info(`  ${k}: ${v}`)
        }
      }
    }

    prompts.outro(`${Object.keys(gw).length} platforms configured`)
  },
})

export const GatewayLoginCommand = cmd({
  command: "login",
  describe: "configure a messaging platform",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Configure messaging platform")

        const selected = await prompts.autocomplete({
          message: "Select platform",
          maxItems: 8,
          options: PLATFORMS.map((p) => ({
            label: p.name,
            value: p.id,
            hint: p.free ? "free" : "paid",
          })),
        })
        if (prompts.isCancel(selected)) throw new UI.CancelledError()
        const id = selected as string
        const meta = platformById(id)
        if (!meta) { prompts.log.error(`Unknown platform: ${id}`); return }

        const promptsList = PROMPTS[id] || [{ label: "API Key / Token", type: "password", placeholder: "...", key: "key" }]
        const inputs: Record<string, string> = {}

        for (const p of promptsList) {
          if (p.type === "password") {
            const v = await prompts.password({ message: p.label })
            if (prompts.isCancel(v)) throw new UI.CancelledError()
            inputs[p.key] = v
          } else {
            const v = await prompts.text({ message: p.label, placeholder: p.placeholder })
            if (prompts.isCancel(v)) throw new UI.CancelledError()
            inputs[p.key] = v
          }
        }

        if (meta.pkg && typeof meta.pkg === "string") {
          for (const pkg of meta.pkg.split(" ")) {
            try { await installPkg(pkg) } catch {}
          }
        }

        const s = prompts.spinner()
        s.start("Validating credentials...")

        let key = ""
        switch (id) {
          case "telegram": key = inputs.token; break
          case "discord": key = inputs.token; break
          case "whatsapp": key = inputs.phone; break
          case "whatsapp_business": key = inputs.token; break
          case "slack": key = inputs.token; break
          case "signal": key = inputs.phone; break
          case "email": key = inputs.password; break
          case "sms": key = `${inputs.sid}:${inputs.token}`; break
          case "matrix": key = inputs.token; break
          case "dingtalk": key = inputs.app_secret; break
          case "feishu": key = inputs.app_secret; break
          case "wecom": key = inputs.secret; break
          case "qqbot": key = inputs.token; break
          case "mattermost": key = inputs.token; break
          case "bluebubbles": key = inputs.api_key; break
          case "webhook": key = inputs.url; break
          case "homeassistant": key = inputs.token; break
          default: key = inputs.key || ""
        }

        const result = await validateCred(id, key, inputs)
        if (result.ok) {
          s.stop(result.info || "Validated")

          await Auth.set(id, { type: "api", key })

          const cfg = await Config.getGlobal()
          const gw = (cfg as any).gateway ?? {}
          const platforms = gw.platforms ?? {}
          platforms[id] = { ...platforms[id], enabled: true }

          for (const [k, v] of Object.entries(inputs)) {
            if (k === "token" || k === "app_secret" || k === "secret" || k === "password" || k === "api_key" || k === "sid") continue
            platforms[id][k] = v
          }

          const updated = { ...(cfg as any), gateway: { ...gw, platforms } }
          await Config.updateGlobal(updated)

          prompts.outro(`${meta.name} configured successfully`)
        } else {
          s.stop(result.error || "Validation failed", 1)

          const retry = await prompts.confirm({ message: "Save credentials anyway?" })
          if (prompts.isCancel(retry)) throw new UI.CancelledError()
          if (retry) {
            await Auth.set(id, { type: "api", key })
            const cfg = await Config.getGlobal()
            const gw = (cfg as any).gateway ?? {}
            const platforms = gw.platforms ?? {}
            platforms[id] = { ...platforms[id], enabled: true }
            for (const [k, v] of Object.entries(inputs)) {
              if (k === "token" || k === "app_secret" || k === "secret" || k === "password" || k === "api_key" || k === "sid") continue
              platforms[id][k] = v
            }
            const updated = { ...(cfg as any), gateway: { ...gw, platforms } }
            await Config.updateGlobal(updated)
          }
        }
      },
    })
  },
})

export const GatewayLogoutCommand = cmd({
  command: "logout",
  describe: "remove a platform",
  async handler() {
    UI.empty()
    const creds = await Auth.all()
    const cfg = await Config.getGlobal()
    const gw = (cfg as any).gateway?.platforms ?? {}

    const options = Object.keys(gw).map((id) => {
      const meta = platformById(id)
      return { label: meta?.name || id, value: id }
    })

    if (options.length === 0) {
      prompts.log.error("No platforms configured")
      return
    }

    prompts.intro("Remove platform")
    const selected = await prompts.select({ message: "Select platform to remove", options })
    if (prompts.isCancel(selected)) throw new UI.CancelledError()

    await Auth.remove(selected as string)
    const copy = { ...gw }
    delete copy[selected as string]
    const updated = { ...(cfg as any), gateway: { ...((cfg as any).gateway ?? {}), platforms: copy } }
    await Config.updateGlobal(updated)

    prompts.outro(`${platformById(selected as string)?.name || selected} removed`)
  },
})

export const GatewayStartCommand = cmd({
  command: "start",
  describe: "start the gateway (if not running with serve)",
  async handler() {
    prompts.intro("Gateway")
    const s = prompts.spinner()
    s.start("Starting gateway...")

    const { Config } = await import("../../config/config")
    const cfg = await Config.getGlobal()
    const { GatewayEngine } = await import("../../gateway")
    const eng = new GatewayEngine()

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

    s.stop("Gateway started")
    prompts.log.info("Gateway is running. Press Ctrl+C to stop.")
    await new Promise(() => {})
  },
})

export const GatewayStopCommand = cmd({
  command: "stop",
  describe: "stop the gateway",
  async handler() {
    prompts.intro("Gateway")
    prompts.log.info("Gateway stops when the process exits (handofaicli serve stop)")
    prompts.outro("Done")
  },
})

export const GatewayStatusCommand = cmd({
  command: "status",
  aliases: ["st"],
  describe: "show gateway status",
  async handler() {
    UI.empty()
    prompts.intro("Gateway Status")
    const { GatewayEngine } = await import("../../gateway")
    const eng = new GatewayEngine()
    const status = eng.getStatus()
    prompts.log.info(`Running: ${status.running}`)
    if (Object.keys(status.platforms).length === 0) {
      prompts.log.info("No platforms running")
    } else {
      for (const [name, running] of Object.entries(status.platforms)) {
        prompts.log.info(`  ${name}: ${running ? "running" : "stopped"}`)
      }
    }
    prompts.outro("Done")
  },
})

export const GatewayUserListCommand = cmd({
  command: "user list [platform]",
  describe: "list users who have messaged the gateway",
  async handler(args: any) {
    UI.empty()
    prompts.intro("Gateway Users")
    const users = await GatewayUser.list(args.platform as string | undefined)
    if (users.length === 0) {
      prompts.log.info("No users found")
    } else {
      for (const u of users) {
        const lastSeen = new Date(u.last_seen).toLocaleString()
        prompts.log.info(`${u.platform_user_id} ${UI.Style.TEXT_DIM}[${u.platform_username || "unknown"}, ${u.message_count} msgs, last: ${lastSeen}]`)
      }
    }
    prompts.outro(`${users.length} users found`)
  },
})

export const GatewayUserGrantCommand = cmd({
  command: "user grant <platform> <userId> <mode>",
  describe: "grant a user build or plan mode access",
  async handler(args: any) {
    UI.empty()
    const { platform, userId, mode } = args as { platform: string; userId: string; mode: "plan" | "build" }
    if (!["plan", "build"].includes(mode)) {
      prompts.log.error("Mode must be 'plan' or 'build'")
      return
    }
    const cfg = await Config.getGlobal()
    const gw = (cfg as any).gateway ?? {}
    const platforms = gw.platforms ?? {}
    if (!platforms[platform]) platforms[platform] = {}
    if (!platforms[platform].user_permissions) platforms[platform].user_permissions = {}
    platforms[platform].user_permissions[userId] = { mode }
    const updated = { ...(cfg as any), gateway: { ...gw, platforms } }
    await Config.updateGlobal(updated)
    prompts.outro(`${userId} granted ${mode} mode on ${platform}`)
  },
})

export const GatewayUserRevokeCommand = cmd({
  command: "user revoke <platform> <userId>",
  describe: "revoke a user's permission override (returns to plan mode)",
  async handler(args: any) {
    UI.empty()
    const { platform, userId } = args as { platform: string; userId: string }
    const cfg = await Config.getGlobal()
    const gw = (cfg as any).gateway ?? {}
    const platforms = gw.platforms ?? {}
    if (platforms[platform]?.user_permissions?.[userId]) {
      delete platforms[platform].user_permissions[userId]
      const updated = { ...(cfg as any), gateway: { ...gw, platforms } }
      await Config.updateGlobal(updated)
    }
    prompts.outro(`${userId} revoked on ${platform}`)
  },
})

export const GatewayUserBlockCommand = cmd({
  command: "user block <platform> <userId>",
  describe: "block a user from using the gateway",
  async handler(args: any) {
    UI.empty()
    const { platform, userId } = args as { platform: string; userId: string }
    const cfg = await Config.getGlobal()
    const gw = (cfg as any).gateway ?? {}
    const platforms = gw.platforms ?? {}
    if (!platforms[platform]) platforms[platform] = {}
    if (!platforms[platform].blocked_users) platforms[platform].blocked_users = []
    if (!platforms[platform].blocked_users.includes(userId)) {
      platforms[platform].blocked_users.push(userId)
    }
    const updated = { ...(cfg as any), gateway: { ...gw, platforms } }
    await Config.updateGlobal(updated)
    prompts.outro(`${userId} blocked on ${platform}`)
  },
})

export const GatewayUserUnblockCommand = cmd({
  command: "user unblock <platform> <userId>",
  describe: "unblock a user",
  async handler(args: any) {
    UI.empty()
    const { platform, userId } = args as { platform: string; userId: string }
    const cfg = await Config.getGlobal()
    const gw = (cfg as any).gateway ?? {}
    const platforms = gw.platforms ?? {}
    if (platforms[platform]?.blocked_users) {
      platforms[platform].blocked_users = platforms[platform].blocked_users.filter((u: string) => u !== userId)
      const updated = { ...(cfg as any), gateway: { ...gw, platforms } }
      await Config.updateGlobal(updated)
    }
    prompts.outro(`${userId} unblocked on ${platform}`)
  },
})

export const GatewayUserInfoCommand = cmd({
  command: "user info <platform> <userId>",
  describe: "show user details",
  async handler(args: any) {
    UI.empty()
    prompts.intro("User Info")
    const { platform, userId } = args as { platform: string; userId: string }
    const user = await GatewayUser.get(platform, userId)
    if (!user) {
      prompts.log.error(`User ${userId} not found on ${platform}`)
      return
    }
    const cfg = await Config.getGlobal()
    const gw = (cfg as any).gateway ?? {}
    const platforms = gw.platforms ?? {}
    const perm = platforms[platform]?.user_permissions?.[userId]
    const blocked = platforms[platform]?.blocked_users?.includes(userId)

    prompts.log.info(`User ID: ${user.platform_user_id}`)
    if (user.platform_username) prompts.log.info(`Username: ${user.platform_username}`)
    prompts.log.info(`First seen: ${new Date(user.first_seen).toLocaleString()}`)
    prompts.log.info(`Last seen: ${new Date(user.last_seen).toLocaleString()}`)
    prompts.log.info(`Messages: ${user.message_count}`)
    prompts.log.info(`Mode: ${perm?.mode || "plan (default)"}`)
    prompts.log.info(`Blocked: ${blocked ? "yes" : "no"}`)
    prompts.outro("Done")
  },
})
