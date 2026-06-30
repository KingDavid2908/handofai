import { createMemo, createSignal, createEffect, onMount, Show, For } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { useToast } from "@tui/ui/toast"
import { useSync } from "@tui/context/sync"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { Spinner } from "../component/spinner"
import { BunProc } from "@/bun"
import type { PairingResult } from "@/gateway/whatsapp-pairing"
import { Global } from "@/global"
import path from "path"
import fs from "fs/promises"
import * as GatewayUser from "@/gateway/user"

const LIST = [
  { id: "telegram", name: "Telegram", free: true, pkg: false },
  { id: "discord", name: "Discord", free: true, pkg: "discord.js" },
  { id: "whatsapp", name: "WhatsApp (Baileys)", free: true, pkg: "@whiskeysockets/baileys" },
  { id: "whatsapp_business", name: "WhatsApp Business (Meta)", free: false, pkg: false },
  { id: "slack", name: "Slack", free: true, pkg: "@slack/web-api @slack/socket-mode" },
  { id: "signal", name: "Signal", free: true, pkg: false },
  { id: "email", name: "Email (SMTP)", free: true, pkg: "nodemailer" },
  { id: "sms", name: "SMS (Twilio)", free: false, pkg: false },
  { id: "matrix", name: "Matrix", free: true, pkg: false },
  { id: "dingtalk", name: "DingTalk", free: true, pkg: false },
  { id: "feishu", name: "Feishu / Lark", free: true, pkg: false },
  { id: "wecom", name: "WeCom", free: true, pkg: false },
  { id: "qqbot", name: "QQ Bot", free: true, pkg: false },
  { id: "mattermost", name: "Mattermost", free: true, pkg: false },
  { id: "bluebubbles", name: "iMessage (BlueBubbles)", free: true, pkg: "socket.io-client" },
  { id: "webhook", name: "Webhook", free: true, pkg: false },
  { id: "homeassistant", name: "Home Assistant", free: true, pkg: false },
]

const PROMPTS: Record<string, { label: string; placeholder?: string; key: string; instruction: string }[]> = {
  telegram: [{
    label: "Bot Token",
    placeholder: "123456789:ABCdef...",
    key: "token",
    instruction: "Create a bot with @BotFather on Telegram. Send /newbot, choose a name, and copy the token (format: 123456:ABCdefGHI-jklMNOpqrSTUvwxYZ). We'll verify by calling Telegram's API.",
  }],
  discord: [{
    label: "Bot Token",
    placeholder: "NTE2ODk0...",
    key: "token",
    instruction: "Create a bot at discord.com/developers/applications. In Bot settings, enable ALL three Privileged Gateway Intents (MESSAGE CONTENT INTENT, SERVER MEMBERS INTENT, PRESENCE INTENT). Reset token and copy it. We'll verify by calling Discord's API.",
  }],
  whatsapp: [{
    label: "Phone Number",
    placeholder: "15551234567",
    key: "phone",
    instruction: "WhatsApp requires pairing with your phone. We'll generate a 6-character code for you to enter in WhatsApp Mobile (Settings → Linked Devices → Link with Phone Number). Enter your phone number with country code, no +. Note: This will NOT message you — you must enter the code in WhatsApp yourself.",
  }],
  whatsapp_business: [
    { label: "API Token", placeholder: "EAAx...", key: "token", instruction: "Requires Meta Business Account with WhatsApp API access. Get System User Token from business.facebook.com with whatsapp_business_messaging permission." },
    { label: "Phone Number ID", placeholder: "1234567890", key: "phone_number_id", instruction: "In WhatsApp Manager → API Setup, copy your Phone Number ID." },
    { label: "Business Account ID", placeholder: "0987654321", key: "business_account_id", instruction: "In Business Settings → Accounts, copy your Business Account ID." },
  ],
  slack: [
    { label: "Bot Token (xoxb-...)", placeholder: "xoxb-...", key: "token", instruction: "Requires TWO tokens from api.slack.com/apps. Enable Socket Mode, create App-Level Token (xapp-...) with connections:write scope. Add bot scopes: chat:write, channels:history, im:history. Subscribe to events: message.im, message.channels. Install app → copy Bot Token (xoxb-...). We'll verify by calling Slack's auth.test API." },
    { label: "App Token (xapp-...)", placeholder: "xapp-...", key: "app_token", instruction: "In your Slack app → Settings → Socket Mode → Enable, create an App-Level Token with scope: connections:write. Copy the xapp-... token." },
    { label: "Signing Secret", placeholder: "abc123...", key: "signing_secret", instruction: "In your Slack app → Basic Information → App Credentials, copy the Signing Secret." },
  ],
  signal: [
    { label: "Account Phone Number", placeholder: "+15551234567", key: "phone", instruction: "Requires signal-cli daemon in HTTP mode. Run: signal-cli -u +15551234567 daemon --http 127.0.0.1:8080. We'll verify the daemon and account are working." },
    { label: "signal-cli HTTP URL", placeholder: "http://127.0.0.1:8080", key: "cli_url", instruction: "URL of your running signal-cli HTTP daemon. Default is http://127.0.0.1:8080." },
  ],
  email: [
    { label: "SMTP Host", placeholder: "smtp.gmail.com", key: "smtp_host", instruction: "For Gmail: enable 2FA, create App Password at myaccount.google.com/apppasswords. Use smtp.gmail.com for SMTP, imap.gmail.com for IMAP. We'll test the SMTP connection." },
    { label: "SMTP Port", placeholder: "587", key: "smtp_port", instruction: "587 for STARTTLS (recommended), 465 for SSL/TLS, 25 for plain (not recommended)." },
    { label: "Username", placeholder: "you@gmail.com", key: "username", instruction: "Your full email address (e.g., you@gmail.com)." },
    { label: "Password / App Password", placeholder: "...", key: "password", instruction: "For Gmail, use an App Password (not your regular password). For other providers, use your email password or app-specific password." },
    { label: "IMAP Host (for receiving)", placeholder: "imap.gmail.com", key: "imap_host", instruction: "IMAP server for receiving emails. For Gmail: imap.gmail.com. For Outlook: outlook.office365.com." },
  ],
  sms: [
    { label: "Account SID", placeholder: "ACxxxxxxxx...", key: "sid", instruction: "Get from console.twilio.com. Account SID is shown in the Console dashboard." },
    { label: "Auth Token", placeholder: "...", key: "token", instruction: "Get from console.twilio.com. Auth Token is shown in the Console dashboard (click 'show' to reveal)." },
    { label: "From Number", placeholder: "+15551234567", key: "from", instruction: "A Twilio phone number with SMS capability. Buy one at console.twilio.com/phone-numbers." },
  ],
  matrix: [
    { label: "Homeserver URL", placeholder: "https://matrix.org", key: "homeserver_url", instruction: "Your Matrix homeserver URL. Default is https://matrix.org. For self-hosted: https://your-server.example.com." },
    { label: "Access Token", placeholder: "syt_...", key: "token", instruction: "Get from Element → Settings → Help & About → Advanced → Access Token. Or create via API: curl -X POST https://server/_matrix/client/v3/login." },
    { label: "User ID", placeholder: "@user:matrix.org", key: "user_id", instruction: "Your Matrix user ID (e.g., @username:server). Shown in your Element profile." },
  ],
  dingtalk: [
    { label: "App ID", placeholder: "dingxxx...", key: "app_id", instruction: "Create app at open-dev.dingtalk.com. Copy AppKey (Client ID) from the application credentials page." },
    { label: "App Secret", placeholder: "...", key: "app_secret", instruction: "Copy AppSecret (Client Secret) from the application credentials page." },
    { label: "Robot Code", placeholder: "robot code", key: "robot_code", instruction: "Enable Stream Mode in bot settings and copy the Robot Code." },
  ],
  feishu: [
    { label: "App ID", placeholder: "cli_xxx...", key: "app_id", instruction: "Create app at open.feishu.cn (China) or open.larksuite.com. Enable Bot capability, publish the app. Copy App ID." },
    { label: "App Secret", placeholder: "...", key: "app_secret", instruction: "Copy App Secret from the application credentials page. We'll verify by obtaining a tenant access token." },
  ],
  wecom: [
    { label: "Corp ID", placeholder: "wwxxx...", key: "corp_id", instruction: "Create a Smart Robot at work.weixin.qq.com → Workspace → Smart Robot. Select API Mode, copy Corp ID." },
    { label: "Agent ID", placeholder: "1000001", key: "agent_id", instruction: "Copy Agent ID from the robot's credentials info page." },
    { label: "Secret", placeholder: "...", key: "secret", instruction: "Copy Secret from the robot's credentials info page. We'll verify by obtaining an access token." },
  ],
  qqbot: [
    { label: "Bot App ID", placeholder: "12345...", key: "app_id", instruction: "Create a bot at q.qq.com. Note App ID from the application page." },
    { label: "Bot Token", placeholder: "...", key: "token", instruction: "Generate a Bot Token in the QQ Bot console, or get it from app_id + secret exchange. We'll verify by calling the QQ Bot API." },
    { label: "Bot Secret", placeholder: "...", key: "secret", instruction: "Copy App Secret from the QQ Bot application page." },
  ],
  mattermost: [
    { label: "Server URL", placeholder: "https://mattermost.example.com", key: "server_url", instruction: "Your Mattermost server URL (e.g., https://mm.example.com). System Console → Integrations → Bot Accounts must be enabled." },
    { label: "Bot Token", placeholder: "...", key: "token", instruction: "Integrations → Bot Accounts → Add Bot Account. Create bot with username, copy the Personal Access Token. We'll verify by fetching your user info." },
    { label: "Team Name", placeholder: "engineering", key: "team", instruction: "The team name (slug) where the bot will operate. Visible in the URL: /<team>/channels." },
  ],
  bluebubbles: [
    { label: "Server URL", placeholder: "http://mac-mini.local:1234", key: "server_url", instruction: "Requires Mac running BlueBubbles from bluebubbles.app. Settings → API → note Server URL. Typically http://<mac-ip>:1234." },
    { label: "API Key", placeholder: "...", key: "api_key", instruction: "Copy the API password from BlueBubbles Settings → API. We'll verify by calling the server info endpoint." },
  ],
  webhook: [
    { label: "Incoming URL", placeholder: "https://hooks.example.com/endpoint", key: "url", instruction: "Enter the URL where we'll send POST requests. We'll send a test request to verify reachability." },
    { label: "Secret (optional)", placeholder: "...", key: "secret", instruction: "Optional shared secret for HMAC validation of incoming webhooks." },
  ],
  homeassistant: [
    { label: "Server URL", placeholder: "http://homeassistant.local:8123", key: "server_url", instruction: "Your Home Assistant server URL (e.g., http://homeassistant.local:8123 or https://ha.example.com)." },
    { label: "Long-Lived Token", placeholder: "...", key: "token", instruction: "Profile → Long-Lived Access Tokens. Create a token, copy it immediately (it won't be shown again). We'll verify by calling HA's API." },
  ],
}

const SECRETS = new Set(["token", "app_secret", "secret", "password", "api_key", "sid"])

function authKey(id: string, inputs: Record<string, string>) {
  switch (id) {
    case "telegram": return inputs.token
    case "discord": return inputs.token
    case "whatsapp": return inputs.phone
    case "whatsapp_business": return inputs.token
    case "slack": return inputs.token
    case "signal": return inputs.phone
    case "email": return inputs.password
    case "sms": return `${inputs.sid}:${inputs.token}`
    case "matrix": return inputs.token
    case "dingtalk": return inputs.app_secret
    case "feishu": return inputs.app_secret
    case "wecom": return inputs.secret
    case "qqbot": return inputs.token
    case "mattermost": return inputs.token
    case "bluebubbles": return inputs.api_key
    case "webhook": return inputs.url
    case "homeassistant": return inputs.token
    default: return inputs.key || ""
  }
}

async function testConnection(id: string, key: string, extra: Record<string, string>): Promise<{ ok: boolean; info?: string; error?: string }> {
  try {
    switch (id) {
      case "telegram": {
        const r = await fetch(`https://api.telegram.org/bot${key}/getMe`)
        const d = await r.json() as any
        if (d.ok) return { ok: true, info: `@${d.result.username}` }
        return { ok: false, error: d.description || "Invalid token" }
      }
      case "discord": {
        const r = await fetch("https://discord.com/api/v10/users/@me", {
          headers: { Authorization: `Bot ${key}` },
        })
        if (r.ok) {
          const d = await r.json() as any
          return { ok: true, info: d.username }
        }
        return { ok: false, error: `${r.status} ${r.statusText}` }
      }
      case "whatsapp_business": {
        const r = await fetch(`https://graph.facebook.com/v22.0/${extra.phone_number_id}`, {
          headers: { Authorization: `Bearer ${key}` },
        })
        if (r.ok) return { ok: true, info: "Connected" }
        const d = await r.json() as any
        return { ok: false, error: d.error?.message || `${r.status}` }
      }
      case "slack": {
        const r = await fetch("https://slack.com/api/auth.test", {
          headers: { Authorization: `Bearer ${key}` },
        })
        const d = await r.json() as any
        if (d.ok) {
          if (extra.app_token && !extra.app_token.startsWith("xapp-")) {
            return { ok: false, error: "App token must start with xapp-" }
          }
          return { ok: true, info: d.user }
        }
        return { ok: false, error: d.error || "Invalid token" }
      }
      case "signal": {
        const url = (extra.cli_url || "http://127.0.0.1:8080").replace(/\/$/, "")
        const phone = extra.phone || key
        const r = await fetch(`${url}/api/v1/check?account=${phone}`)
        if (r.ok) return { ok: true, info: "signal-cli account verified" }
        return { ok: false, error: "Account not found on signal-cli daemon" }
      }
      case "email": {
        const nodemailer = await import("nodemailer")
        const transport = nodemailer.createTransport({
          host: extra.smtp_host || "smtp.gmail.com",
          port: parseInt(extra.smtp_port || "587", 10),
          secure: extra.smtp_port === "465",
          auth: { user: extra.username || "", pass: key },
        })
        await transport.verify()
        transport.close()
        return { ok: true, info: "SMTP connection verified" }
      }
      case "sms": {
        const [sid, token] = key.split(":")
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
          headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) },
        })
        if (r.ok) {
          const d = await r.json() as any
          return { ok: true, info: d.friendly_name }
        }
        const d = await r.json() as any
        return { ok: false, error: d.message || `${r.status}` }
      }
      case "matrix": {
        const r = await fetch(`${extra.homeserver_url}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${key}` },
        })
        if (r.ok) {
          const d = await r.json() as any
          return { ok: true, info: d.user_id }
        }
        return { ok: false, error: `${r.status}` }
      }
      case "dingtalk": {
        const r = await fetch("https://oapi.dingtalk.com/gettoken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appKey: extra.app_id, appSecret: key }),
        })
        const d = await r.json() as any
        if (d.errcode === 0) return { ok: true, info: "Token obtained" }
        return { ok: false, error: d.errmsg || `Error ${d.errcode}` }
      }
      case "feishu": {
        const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app_id: extra.app_id, app_secret: key }),
        })
        const d = await r.json() as any
        if (d.tenant_access_token) return { ok: true, info: "Token obtained" }
        return { ok: false, error: d.msg || "Invalid credentials" }
      }
      case "wecom": {
        const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${extra.corp_id}&corpsecret=${key}`)
        const d = await r.json() as any
        if (d.errcode === 0) return { ok: true, info: "Token obtained" }
        return { ok: false, error: d.errmsg || `Error ${d.errcode}` }
      }
      case "qqbot": {
        const r = await fetch("https://api.sgroup.qq.com/users/@me", {
          headers: { Authorization: `QQBot ${key}` },
        })
        if (r.ok) return { ok: true, info: "Valid" }
        return { ok: false, error: `${r.status}` }
      }
      case "mattermost": {
        const r = await fetch(`${extra.server_url}/api/v4/users/me`, {
          headers: { Authorization: `Bearer ${key}` },
        })
        if (r.ok) {
          const d = await r.json() as any
          return { ok: true, info: d.username }
        }
        return { ok: false, error: `${r.status}` }
      }
      case "bluebubbles": {
        const r = await fetch(`${extra.server_url}/api/v1/server/info`, {
          headers: { "Z-API-Key": key },
        })
        if (r.ok) return { ok: true, info: "Server connected" }
        return { ok: false, error: `${r.status}` }
      }
      case "webhook": {
        new URL(key)
        const r = await fetch(key, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ test: true, platform: "handofai" }),
        })
        return { ok: true, info: `${r.status} — reachable` }
      }
      case "homeassistant": {
        const r = await fetch(`${extra.server_url}/api/config`, {
          headers: { Authorization: `Bearer ${key}` },
        })
        if (r.ok) {
          const d = await r.json() as any
          return { ok: true, info: d.version || "Connected" }
        }
        return { ok: false, error: `${r.status} ${r.statusText}` }
      }
      case "whatsapp": {
        const sessionDir = path.join(Global.Path.state, "gateway", "whatsapp-session")
        try {
          const entries = await fs.readdir(sessionDir)
          const hasCreds = entries.some(f => f.includes("creds"))
          const hasKeys = entries.some(f => f.includes("pre-key") || f.includes("session"))
          
          if (hasCreds && hasKeys) {
            return { ok: true, info: `Session active (${entries.length} files)` }
          }
          if (entries.length > 0) {
            return { ok: true, info: "Session files present (may need re-pairing)" }
          }
          return { ok: false, error: "No session files - re-pair required" }
        } catch {
          return { ok: false, error: "No session directory found" }
        }
      }
      default:
        return { ok: true, info: "Stored" }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

type Status = "connected" | "enabled" | "session_expired" | "disabled" | "unconfigured"

function StatusBadge(props: { state: Status }) {
  const { theme } = useTheme()
  switch (props.state) {
    case "connected":
      return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Connected</span>
    case "enabled":
      return <span style={{ fg: theme.warning }}>○ Enabled (gateway not running)</span>
    case "session_expired":
      return <span style={{ fg: theme.error }}>✗ Session expired</span>
    case "disabled":
      return <span style={{ fg: theme.textMuted }}>● Disabled</span>
    default:
      return <span style={{ fg: theme.textMuted }}>○ Not connected</span>
  }
}

function LoadingDialog(props: { message: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.message}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1} paddingTop={1}>
        <Spinner>Installing...</Spinner>
      </box>
    </box>
  )
}

export function DialogGateway() {
  const dialog = useDialog()
  const toast = useToast()
  const sync = useSync()
  const { theme } = useTheme()
  const [auth, setAuth] = createSignal<Record<string, any>>({})
  const [statusMap, setStatusMap] = createSignal<Record<string, Status>>({})

  createEffect(() => {
    refresh()
    const timer = setInterval(() => updateStatusMap(), 2000)
    return () => clearInterval(timer)
  })

  const updateStatusMap = async () => {
    const map: Record<string, Status> = {}
    for (const p of LIST) {
      map[p.id] = await state(p.id)
    }
    setStatusMap(map)
  }

  const refresh = async () => {
    try {
      const data = await Auth.all()
      setAuth(data)
      await updateStatusMap()
    } catch {
      toast.show({ message: "Failed to refresh auth status", variant: "error" })
    }
  }

  const state = async (id: string): Promise<Status> => {
    const gw = (sync.data.config as any)?.gateway?.platforms ?? {}
    const entry = gw[id]
    const hasAuth = !!auth()[id]
    if (!entry) return "unconfigured"
    if (entry.enabled === false) return "disabled"
    if (!hasAuth) return "unconfigured"

    try {
      const resp = await fetch("/global/gateway/status")
      const data = await resp.json()
      if (data.platforms[id] === true) {
        const sessionCheck = await testConnection(id, auth()[id].key, {})
        return sessionCheck.ok ? "connected" : "session_expired"
      }
    } catch {
      const sessionCheck = await testConnection(id, auth()[id].key, {})
      return sessionCheck.ok ? "connected" : "enabled"
    }

    return "enabled"
  }

  async function ensurePkg(pkg: string): Promise<string[]> {
    const pkgs = pkg.split(" ")
    const paths: string[] = []
    for (const p of pkgs) {
      dialog.replace(() => <LoadingDialog message={`Installing ${p}...`} />)
      try {
        const installed = await BunProc.install(p, "latest")
        paths.push(installed)
      } catch (e: any) {
        const retry = await DialogConfirm.show(dialog, "Install Failed", `Failed to install ${p}: ${e.message}`, "Retry")
        if (retry === true) return ensurePkg(pkg)
        throw e
      }
    }
    return paths
  }

  const openSetup = async (id: string) => {
    const meta = LIST.find((p) => p.id === id)!
    const prompts = PROMPTS[id] || [{ label: "API Key / Token", key: "key", instruction: "Enter your API key or token." }]

    if (meta.pkg) {
      try {
        await ensurePkg(meta.pkg as string)
      } catch {
        dialog.clear()
        return
      }
    }

    const inputs: Record<string, string> = {}

    for (const p of prompts) {
      const value = await DialogPrompt.show(dialog, p.label, {
        placeholder: p.placeholder,
        description: () => (
          <box gap={1} paddingBottom={1}>
            <text fg={theme.textMuted} wrapMode="word">{p.instruction}</text>
          </box>
        ),
      })
      if (value === null) return
      inputs[p.key] = value
    }

    if (id === "whatsapp") {
      await openWhatsAppSetup(inputs.phone)
      return
    }

    const key = authKey(id, inputs)

    toast.show({ message: `Testing connection to ${meta.name}...`, variant: "info" })

    const result = await testConnection(id, key, inputs)

    if (result.ok) {
      await Auth.set(id, { type: "api", key })

      const cfg = await Config.getGlobal()
      const gw = (cfg as any).gateway ?? {}
      const platforms = gw.platforms ?? {}
      platforms[id] = { ...platforms[id], enabled: true }
      for (const [k, v] of Object.entries(inputs)) {
        if (SECRETS.has(k)) continue
        platforms[id][k] = v
      }
      await Config.updateGlobal({ ...(cfg as any), gateway: { ...gw, platforms } })

      await refresh()
      toast.show({ message: `${meta.name} connected! ${result.info || ""}`, variant: "success" })
      dialog.clear()
      return
    }

    const retry = await DialogConfirm.show(dialog, "Connection Failed", result.error || "Validation failed", "Save Anyway")
    if (retry === true) {
      await Auth.set(id, { type: "api", key })

      const cfg = await Config.getGlobal()
      const gw = (cfg as any).gateway ?? {}
      const platforms = gw.platforms ?? {}
      platforms[id] = { ...platforms[id], enabled: true }
      for (const [k, v] of Object.entries(inputs)) {
        if (SECRETS.has(k)) continue
        platforms[id][k] = v
      }
      await Config.updateGlobal({ ...(cfg as any), gateway: { ...gw, platforms } })

      await refresh()
      toast.show({ message: `${meta.name} saved (validation failed)`, variant: "warning" })
    } else {
      toast.show({ message: `${result.error}`, variant: "error" })
    }
    dialog.clear()
  }

  const openWhatsAppSetup = async (phone: string) => {
    const meta = LIST.find((p) => p.id === "whatsapp")!

    dialog.replace(() => <LoadingDialog message="Installing @whiskeysockets/baileys qrcode-terminal..." />)

    let baileysPath: string
    try {
      baileysPath = await BunProc.install("@whiskeysockets/baileys", "latest")
      await BunProc.install("qrcode-terminal", "latest")
    } catch (e: any) {
      toast.show({ message: `Failed to install Baileys: ${e.message}`, variant: "error" })
      dialog.clear()
      return
    }

    const method = await DialogSelect.show(dialog, "WhatsApp Setup", [
      { title: "Pairing Code", value: "code", description: "Enter 8-character code on your phone" },
      { title: "QR Code", value: "qr", description: "Scan QR code with your phone" },
    ])

    if (method === null) {
      dialog.clear()
      return
    }

    const usePairingCode = method === "code"

    if (usePairingCode) {
      dialog.replace(() => <LoadingDialog message="Starting WhatsApp pairing..." />)

      const { startPairing } = await import("@/gateway/whatsapp-pairing")
      let pairing: Awaited<ReturnType<typeof startPairing>> | undefined
      try {
        pairing = await startPairing(phone, baileysPath, true)
      } catch (e: any) {
        toast.show({ message: `Failed to start pairing: ${e.message}`, variant: "error" })
        dialog.clear()
        return
      }

      if (!pairing.code) {
        toast.show({ message: "Already paired! Credentials saved.", variant: "success" })
        await Auth.set("whatsapp", { type: "api", key: phone })
        const cfg = await Config.getGlobal()
        const gw = (cfg as any).gateway ?? {}
        const platforms = gw.platforms ?? {}
        platforms["whatsapp"] = { ...platforms["whatsapp"], enabled: true, phone }
        await Config.updateGlobal({ ...(cfg as any), gateway: { ...gw, platforms } })
        await refresh()
        dialog.clear()
        return
      }

      dialog.replace(() => (
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              WhatsApp Pairing
            </text>
            <text fg={theme.textMuted} onMouseUp={() => { pairing?.cleanup(); dialog.clear() }}>
              esc
            </text>
          </box>
          <box gap={1}>
            <text fg={theme.text}>Open WhatsApp on your phone:</text>
            <text fg={theme.text}>Settings → Linked Devices → Link with Phone Number</text>
            <box paddingTop={1} paddingBottom={1}>
              <text attributes={TextAttributes.BOLD} fg={theme.success}>
                {pairing.code}
              </text>
            </box>
            <text fg={theme.textMuted}>Enter this code in WhatsApp...</text>
          </box>
          <WhatsAppSpinner phone={phone} pairing={pairing} />
        </box>
      ))
    } else {
      dialog.replace(() => <LoadingDialog message="Starting WhatsApp QR pairing..." />)

      const { startPairing } = await import("@/gateway/whatsapp-pairing")
      let pairing: Awaited<ReturnType<typeof startPairing>> | undefined
      try {
        pairing = await startPairing(phone, baileysPath, false)
      } catch (e: any) {
        toast.show({ message: `Failed to start QR pairing: ${e.message}`, variant: "error" })
        dialog.clear()
        return
      }

      if (!pairing.qr) {
        toast.show({ message: "Already paired! Credentials saved.", variant: "success" })
        await Auth.set("whatsapp", { type: "api", key: phone })
        const cfg = await Config.getGlobal()
        const gw = (cfg as any).gateway ?? {}
        const platforms = gw.platforms ?? {}
        platforms["whatsapp"] = { ...platforms["whatsapp"], enabled: true, phone }
        await Config.updateGlobal({ ...(cfg as any), gateway: { ...gw, platforms } })
        await refresh()
        dialog.clear()
        return
      }

      dialog.replace(() => (
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              WhatsApp QR Pairing
            </text>
            <text fg={theme.textMuted} onMouseUp={() => { pairing?.cleanup(); dialog.clear() }}>
              esc
            </text>
          </box>
          <box>
            <text fg={theme.text}>Open WhatsApp on your phone:</text>
            <text fg={theme.text}>Settings → Linked Devices → Link a Device</text>
            <text fg={theme.text}>Scan this QR code:</text>
            <box>
              <For each={(pairing.qr || "").split('\n')}>
                {(line: string) => <text fg={theme.text} wrapMode="none">{line}</text>}
              </For>
            </box>
          </box>
          <WhatsAppSpinner phone={phone} pairing={pairing} />
        </box>
      ))
      dialog.setSize("xlarge")
    }
  }

  const WhatsAppSpinner = (props: { phone: string; pairing: PairingResult }) => {
    const { theme } = useTheme()
    const [waiting, setWaiting] = createSignal(true)
    const [error, setError] = createSignal("")
    const [success, setSuccess] = createSignal(false)
    const [countdown, setCountdown] = createSignal(5)

    onMount(async () => {
      try {
        await props.pairing.wait()
        setWaiting(false)
        setSuccess(true)

        await Auth.set("whatsapp", { type: "api", key: props.phone })
        const cfg = await Config.getGlobal()
        const gw = (cfg as any).gateway ?? {}
        const platforms = gw.platforms ?? {}
        platforms["whatsapp"] = { ...platforms["whatsapp"], enabled: true, phone: props.phone }
        await Config.updateGlobal({ ...(cfg as any), gateway: { ...gw, platforms } })

        await new Promise(r => setTimeout(r, 200))
        await refresh()

        const updated = await Auth.all()
        if (!updated["whatsapp"]) {
          toast.show({ message: "Auth save failed, retrying...", variant: "warning" })
          await new Promise(r => setTimeout(r, 200))
          await refresh()
        }

        toast.show({ message: "WhatsApp paired successfully!", variant: "success" })

        const timer = setInterval(() => {
          setCountdown(c => {
            if (c <= 1) {
              clearInterval(timer)
              dialog.clear()
              return 0
            }
            return c - 1
          })
        }, 1000)
      } catch (e: any) {
        setWaiting(false)
        setError(e.message)
      }
    })

    return (
      <box gap={1}>
        {waiting() && (
          <text fg={theme.textMuted}>Waiting for pairing to complete...</text>
        )}
        {success() && (
          <box gap={1}>
            <text fg={theme.success} attributes={TextAttributes.BOLD}>✓ Paired successfully!</text>
            <text fg={theme.textMuted}>Closing in {countdown()}s... (Press ESC to close)</text>
          </box>
        )}
        {error() && (
          <text fg={theme.error}>{error()}</text>
        )}
      </box>
    )
  }

  const openConnectedMenu = async (id: string) => {
    const meta = LIST.find((p) => p.id === id)!
    const cred = auth()[id]

    const opts: { title: string; value: string; onSelect: () => Promise<void> }[] = [
      {
        title: "Test Connection",
        value: "test",
        async onSelect() {
          if (cred?.type === "api") {
            toast.show({ message: `Testing ${meta.name}...`, variant: "info" })
            const pcfg = (sync.data.config as any)?.gateway?.platforms?.[id] ?? {}
            const result = await testConnection(id, cred.key, pcfg)
            if (result.ok) {
              toast.show({ message: `${meta.name}: ${result.info || "OK"}`, variant: "success" })
            } else {
              toast.show({ message: `${meta.name}: ${result.error || "failed"}`, variant: "error" })
            }
          }
          dialog.clear()
        },
      },
      {
        title: "Reconfigure",
        value: "reconfigure",
        async onSelect() {
          openSetup(id)
        },
      },
      {
        title: "Disable",
        value: "disable",
        async onSelect() {
          const cfg = await Config.getGlobal()
          const gw = (cfg as any).gateway ?? {}
          const platforms = gw.platforms ?? {}
          if (platforms[id]) platforms[id].enabled = false
          else platforms[id] = { enabled: false }
          await Config.updateGlobal({ ...(cfg as any), gateway: { ...gw, platforms } })
          toast.show({ message: `${meta.name} disabled`, variant: "info" })
          dialog.clear()
        },
      },
      {
        title: "Remove",
        value: "remove",
        async onSelect() {
          const ok = await DialogConfirm.show(dialog, "Remove Platform", `Remove ${meta.name} configuration and credentials?`)
          if (ok !== true) return
          await Auth.remove(id)
          const cfg = await Config.getGlobal()
          const gw = (cfg as any).gateway ?? {}
          const platforms = { ...(gw.platforms ?? {}) }
          delete platforms[id as any]
          await Config.updateGlobal({ ...(cfg as any), gateway: { ...gw, platforms } })
          
          // Clear session files for WhatsApp
          if (id === "whatsapp") {
            const sessionDir = path.join(Global.Path.state, "gateway", "whatsapp-session")
            await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {})
            await GatewayUser.clearPlatform("whatsapp")
          }
          
          await refresh()
          toast.show({ message: `${meta.name} removed`, variant: "info" })
          dialog.clear()
        },
      },
    ]

    dialog.replace(() => (
      <DialogSelect
        title={meta.name}
        options={opts}
      />
    ))
  }

  const openTestAll = async () => {
    const authed = auth()
    const configured: string[] = []
    const results: { name: string; ok: boolean; info?: string; error?: string }[] = []

    for (const p of LIST) {
      const cred = authed[p.id]
      if (!cred || cred.type !== "api") continue
      configured.push(p.id)
    }

    if (configured.length === 0) {
      toast.show({ message: "No platforms configured with credentials", variant: "info" })
      dialog.clear()
      return
    }

    toast.show({ message: `Testing ${configured.length} platforms...`, variant: "info" })

    for (const pid of configured) {
      const meta = LIST.find((p) => p.id === pid)!
      const cred = authed[pid]
      const pcfg = (sync.data.config as any)?.gateway?.platforms?.[pid] ?? {}
      const result = await testConnection(pid, cred.key, pcfg)
      results.push({ name: meta.name, ...result })
    }

    const ok = results.filter((r) => r.ok)
    const fail = results.filter((r) => !r.ok)
    const lines = [
      ...ok.map((r) => `${r.name}: ${r.info || "OK"}`),
      ...fail.map((r) => `${r.name}: ${r.error || "failed"}`),
    ]
    toast.show({
      message: `${ok.length} connected, ${fail.length} failed\n${lines.join("\n")}`,
      variant: fail.length === 0 ? "success" : "warning",
    })
    dialog.clear()
  }

  const openReset = async () => {
    const ok = await DialogConfirm.show(
      dialog,
      "Reset Gateway",
      "Remove all gateway platform configurations and credentials?",
    )
    if (ok !== true) return

    const authed = auth()
    for (const pid of Object.keys(authed)) {
      if (!LIST.some((p) => p.id === pid)) continue
      try { await Auth.remove(pid) } catch {}
    }

    const cfg = await Config.getGlobal()
    const updated = { ...(cfg as any) }
    if (updated.gateway) {
      updated.gateway = { ...updated.gateway, platforms: {} }
    }
    await Config.updateGlobal(updated)

    await refresh()
    toast.show({ message: "Gateway configuration reset", variant: "info" })
    dialog.clear()
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const sm = statusMap()
    const platforms = LIST.map((p) => ({
      title: p.name,
      value: p.id,
      description: p.free ? "free" : "paid",
      footer: <StatusBadge state={sm[p.id] ?? "unconfigured"} />,
      category: "Messaging Platforms",
      onSelect: async () => {
        const s = sm[p.id] ?? "unconfigured"
        if (s === "connected") {
          openConnectedMenu(p.id)
          return
        }
        openSetup(p.id)
      },
    }))

    return [
      ...platforms,
      {
        title: "Test All Connections",
        value: "test-all",
        category: "Actions",
        onSelect: openTestAll,
      },
      {
        title: "Reset Configuration",
        value: "reset",
        category: "Actions",
        onSelect: openReset,
      },
    ]
  })

  return (
    <DialogSelect
      title="Gateway"
      placeholder="Search platforms..."
      options={options()}
      onSelect={() => {
        // Don't close on select, let individual onSelect handlers manage dialog
      }}
    />
  )
}
