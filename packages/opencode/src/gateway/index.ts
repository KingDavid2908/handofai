import { Config } from "../config/config"
import { Auth } from "../auth"
import { Log } from "../util/log"
import type { Handler, PlatformAdapter, SendOpts, SendResult } from "./adapter"
import { TelegramAdapter } from "./platforms/telegram"
import { DiscordAdapter } from "./platforms/discord"
import { WhatsAppBaileysAdapter } from "./platforms/whatsapp-baileys"
import { WhatsAppBusinessAdapter } from "./platforms/whatsapp-business"
import { SlackAdapter } from "./platforms/slack"
import { SignalAdapter } from "./platforms/signal"
import { EmailAdapter } from "./platforms/email"
import { SmsAdapter } from "./platforms/sms"
import { MatrixAdapter } from "./platforms/matrix"
import { DingTalkAdapter } from "./platforms/dingtalk"
import { FeishuAdapter } from "./platforms/feishu"
import { WeComAdapter } from "./platforms/wecom"
import { QqBotAdapter } from "./platforms/qqbot"
import { MattermostAdapter } from "./platforms/mattermost"
import { BlueBubblesAdapter } from "./platforms/bluebubbles"
import { WebhookAdapter } from "./platforms/webhook"
import { HomeAssistantAdapter } from "./platforms/homeassistant"

const log = Log.create({ service: "gateway" })

let sharedEngine: GatewayEngine | undefined

export function getSharedEngine(): GatewayEngine | undefined {
  return sharedEngine
}

export function setSharedEngine(engine: GatewayEngine | undefined): void {
  sharedEngine = engine
}

const ADAPTERS: Record<string, (auth: string, cfg: Record<string, any>) => PlatformAdapter> = {
  telegram: (auth) => new TelegramAdapter(auth),
  discord: (auth) => new DiscordAdapter(auth),
  whatsapp: (auth) => new WhatsAppBaileysAdapter(auth),
  whatsapp_business: (auth, cfg) => new WhatsAppBusinessAdapter(auth, cfg),
  slack: (auth, cfg) => new SlackAdapter(auth, cfg),
  signal: (auth, cfg) => new SignalAdapter(auth, cfg),
  email: (auth, cfg) => new EmailAdapter(auth, cfg),
  sms: (auth, cfg) => new SmsAdapter(auth, cfg),
  matrix: (auth, cfg) => new MatrixAdapter(auth, cfg),
  dingtalk: (auth, cfg) => new DingTalkAdapter(auth, cfg),
  feishu: (auth, cfg) => new FeishuAdapter(auth, cfg),
  wecom: (auth, cfg) => new WeComAdapter(auth, cfg),
  qqbot: (auth, cfg) => new QqBotAdapter(auth, cfg),
  mattermost: (auth, cfg) => new MattermostAdapter(auth, cfg),
  bluebubbles: (auth, cfg) => new BlueBubblesAdapter(auth, cfg),
  webhook: (auth, cfg) => new WebhookAdapter(auth, cfg),
  homeassistant: (auth, cfg) => new HomeAssistantAdapter(auth, cfg),
}

export interface GatewayStatus {
  running: boolean
  platforms: Record<string, boolean>
}

export class GatewayEngine {
  private adapters = new Map<string, PlatformAdapter>()
  private handler?: Handler
  private running = false

  async start(handler: Handler): Promise<void> {
    if (this.running) return
    this.running = true
    this.handler = handler

    const cfg = await Config.getGlobal()
    const platforms = ((cfg as any).gateway?.platforms ?? {}) as Record<string, { enabled: boolean; method?: string }>

    if (!platforms || Object.keys(platforms).length === 0) {
      log.info("no gateway platforms configured")
      return
    }

    const creds = await Auth.all()

    for (const [name, pcfg] of Object.entries(platforms)) {
      if (!pcfg.enabled) continue

      const cred = creds[name]
      if (!cred) {
        log.warn("no credentials for platform", { platform: name })
        continue
      }

      const key = cred.type === "api" ? cred.key : undefined
      if (!key) {
        log.warn("unsupported auth type for platform", { platform: name, type: cred.type })
        continue
      }

      const factory = ADAPTERS[name]
      if (!factory) {
        log.warn("no adapter for platform", { platform: name })
        continue
      }

      try {
        const adapter = factory(key, pcfg as any)
        await adapter.start(handler)
        this.adapters.set(name, adapter)
        log.info("platform started", { platform: name })
      } catch (err) {
        log.error("failed to start platform adapter", { platform: name, error: String(err) })
      }
    }

    log.info("gateway started", { platforms: [...this.adapters.keys()] })
  }

  async stop(): Promise<void> {
    this.running = false
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.stop()
        log.info("platform stopped", { platform: name })
      } catch (err) {
        log.error("failed to stop platform", { platform: name, error: String(err) })
      }
    }
    this.adapters.clear()
  }

  async send(platform: string, chat: string, text: string, opts?: SendOpts): Promise<SendResult> {
    const a = this.adapters.get(platform)
    if (!a) return { success: false, error: `platform not running: ${platform}` }
    return a.send(chat, text, opts)
  }

  getStatus(): GatewayStatus {
    const platforms: Record<string, boolean> = {}
    for (const [name, a] of this.adapters) {
      platforms[name] = a.isRunning()
    }
    return { running: this.running, platforms }
  }

  static async register(platform: string, factory: (auth: string, cfg: Record<string, any>) => PlatformAdapter) {
    ADAPTERS[platform] = factory
  }
}
