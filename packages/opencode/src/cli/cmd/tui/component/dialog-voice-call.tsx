import { createMemo, createSignal } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { Config } from "@/config/config"
import { useToast } from "@tui/ui/toast"
import { DialogPrompt } from "../ui/dialog-prompt"

const PROVIDERS: { id: string; name: string; category: string }[] = [
  { id: "telegram_voice", name: "Telegram Voice (FREE — P2P VoIP)", category: "Free" },
  { id: "whatsapp_business", name: "WhatsApp Business Voice Call", category: "Free-ish" },
  { id: "webrtc", name: "WebRTC Browser (FREE)", category: "Free" },
  { id: "voipms", name: "VoIP.ms + JsSIP", category: "Low Cost" },
  { id: "twilio", name: "Twilio", category: "Paid" },
  { id: "telnyx", name: "Telnyx", category: "Paid" },
  { id: "plivo", name: "Plivo", category: "Paid" },
  { id: "livekit_phone", name: "LiveKit Phone Numbers", category: "Paid" },
]

const PROMPTS: Record<string, { label: string; key: string; placeholder?: string }[]> = {
  twilio: [
    { label: "Account SID", key: "account_sid", placeholder: "AC..." },
    { label: "Auth Token", key: "auth_token" },
    { label: "Twilio Phone Number", key: "phone_number", placeholder: "+234..." },
    { label: "Your Personal Number", key: "your_number", placeholder: "+234..." },
  ],
  telnyx: [
    { label: "API Key", key: "api_key", placeholder: "KEY..." },
    { label: "Phone Number", key: "phone_number", placeholder: "+234..." },
    { label: "Your Personal Number", key: "your_number", placeholder: "+234..." },
  ],
  voipms: [
    { label: "Username", key: "username" },
    { label: "Password", key: "password" },
    { label: "DID Number", key: "did", placeholder: "+1..." },
  ],
  plivo: [
    { label: "Auth ID", key: "auth_id" },
    { label: "Auth Token", key: "auth_token" },
    { label: "Phone Number", key: "phone_number", placeholder: "+1..." },
  ],
  telegram_voice: [
    { label: "Phone Number", key: "phone_number", placeholder: "+234..." },
    { label: "API ID", key: "api_id" },
    { label: "API Hash", key: "api_hash" },
  ],
  whatsapp_business: [
    { label: "WABA ID", key: "waba_id" },
    { label: "Phone Number ID", key: "phone_id" },
    { label: "Access Token", key: "access_token" },
  ],
}

export function DialogVoiceCall() {
  const dialog = useDialog()
  const toast = useToast()
  const [cfg, setCfg] = createSignal<any>(null)

  const loadConfig = async () => {
    const c = await Config.getGlobal()
    setCfg(c)
  }

  loadConfig()

  const current = createMemo(() => {
    const c = cfg()
    if (!c) return null
    return c.voice_call
  })

  const save = async (patch: any) => {
    const c = cfg()
    if (!c) return
    const updated = { ...c, voice_call: { ...(c.voice_call || {}), ...patch } }
    await Config.updateGlobal(updated)
    setCfg(updated)
  }

  const openProviderSetup = async (providerId: string) => {
    const c = cfg()
    const promptsList = PROMPTS[providerId]
    if (!promptsList) {
      // Simple toggle for providers without setup
      const providers = c?.voice_call?.providers || {}
      await save({
        providers: {
          ...providers,
          [providerId]: { ...providers[providerId], enabled: !providers[providerId]?.enabled },
        },
      })
      dialog.clear()
      toast.show({ message: `${providerId} toggled`, variant: "info", duration: 2000 })
      return
    }

    const inputs: Record<string, string> = {}
    const providers = c?.voice_call?.providers || {}

    const runPrompt = async (index: number) => {
      if (index >= promptsList.length) {
        // All prompts done — save
        await save({
          providers: {
            ...providers,
            [providerId]: { ...providers[providerId], ...inputs, enabled: true },
          },
        })
        dialog.clear()
        toast.show({ message: `${providerId} configured`, variant: "success", duration: 2000 })
        return
      }

      const p = promptsList[index]
      dialog.replace(() => (
        <DialogPrompt
          title={p.label}
          placeholder={p.placeholder || ""}
          value={providers[providerId]?.[p.key] || ""}
          onConfirm={async (value) => {
            inputs[p.key] = value
            setTimeout(() => runPrompt(index + 1), 50)
          }}
        />
      ))
    }

    runPrompt(0)
  }

  const openPersonalNumber = async () => {
    const c = cfg()
    dialog.replace(() => (
      <DialogPrompt
        title="Your Personal Phone Number"
        placeholder="+2348012345678"
        value={c?.voice_call?.your_number || ""}
        onConfirm={async (number) => {
          await save({ your_number: number })
          dialog.clear()
          toast.show({ message: "Personal number saved", variant: "success", duration: 2000 })
        }}
      />
    ))
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const c = current()
    return [
      ...PROVIDERS.map((p) => ({
        title: p.name,
        value: p.id,
        description: c?.providers?.[p.id]?.enabled ? "Enabled" : "Disabled",
        category: p.category,
        onSelect: () => openProviderSetup(p.id),
      })),
      {
        title: "Your Personal Number",
        value: "personal_number",
        description: c?.your_number || "Not set",
        category: "Settings",
        onSelect: openPersonalNumber,
      },
      {
        title: "Test Call",
        value: "test_call",
        category: "Actions",
        onSelect: async () => {
          toast.show({ message: "Test call feature coming soon", variant: "info", duration: 3000 })
          dialog.clear()
        },
      },
    ]
  })

  return (
    <DialogSelect
      title="Voice Call Configuration"
      options={options()}
    />
  )
}
