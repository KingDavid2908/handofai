import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useToast } from "@tui/ui/toast"
import { Clipboard } from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { VoiceTool } from "@/tool/voice"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const route = useRoute()

  const userText = createMemo(() => {
    const msg = message()
    if (!msg || msg.role !== "user") return ""
    const parts = sync.data.part[msg.id] ?? []
    return parts.filter((p): p is TextPart => p.type === "text" && !p.synthetic).map((p) => p.text).join("")
  })

  const assistantText = createMemo(() => {
    const msg = message()
    if (!msg) return ""
    const allMsgs = messages()
    const idx = allMsgs.findIndex((x) => x.id === msg.id)
    for (let i = idx + 1; i < allMsgs.length; i++) {
      if (allMsgs[i].role === "assistant") {
        const parts = sync.data.part[allMsgs[i].id] ?? []
        return parts.filter((p): p is TextPart => p.type === "text" && !p.synthetic).map((p) => p.text).join("")
      }
    }
    return ""
  })

  const filterForSpeech = (text: string): string => {
    return text
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
      .replace(/\[Tool:[\s\S]*?\]/g, "")
      .replace(/Result:[\s\S]*?(?=\n\n|$)/g, "")
      .replace(/---[\s\S]*?---/g, "")
      .replace(/\[System:[\s\S]*?\]/g, "")
      .replace(/\[Action:[\s\S]*?\]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  const filteredAssistantText = createMemo(() => filterForSpeech(assistantText()))

  async function synthesizeAndPlay(text: string) {
    toast.show({ message: "Synthesizing speech...", variant: "info", duration: 3000 })
    try {
      const tool = await VoiceTool.init()
      const result = await tool.execute(
        { action: "synthesize", text },
        {
          sessionID: props.sessionID as any,
          messageID: props.messageID as any,
          agent: "",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        },
      )
      const audioPath = result.attachments?.[0]?.url
      if (!audioPath) {
        toast.show({ message: "TTS returned no audio", variant: "error" })
        return
      }
      const fsPath = audioPath.startsWith("file://") ? audioPath.slice(7) : audioPath
      const ext = fsPath.split(".").pop()?.toLowerCase()
      if (ext === "wav") {
        const { play } = await import("sound-play") as any
        await play(fsPath)
      } else {
        await Bun.spawn(["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", fsPath]).exited
      }
      toast.show({ message: "Playing...", variant: "info", duration: 2000 })
    } catch (e: any) {
      toast.show({ message: `TTS failed: ${e.message}`, variant: "error" })
    }
  }

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
            const msg = message()
            if (!msg) return

            sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })

            if (props.setPrompt) {
              const parts = sync.data.part[msg.id]
              const promptInfo = parts.reduce(
                (agg, part) => {
                  if (part.type === "text") {
                    if (!part.synthetic) agg.input += (part as TextPart).text
                  }
                  if (part.type === "file") agg.parts.push(strip(part))
                  return agg
                },
                { input: "", parts: [] as PromptInfo["parts"] },
              )
              props.setPrompt(promptInfo)
            }

            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += (part as TextPart).text
              }
              return agg
            }, "")

            await Clipboard.copy(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const initialPrompt = (() => {
              const msg = message()
              if (!msg) return undefined
              const parts = sync.data.part[msg.id]
              return parts.reduce(
                (agg, part) => {
                  if (part.type === "text") {
                    if (!part.synthetic) agg.input += (part as TextPart).text
                  }
                  if (part.type === "file") agg.parts.push(part)
                  return agg
                },
                { input: "", parts: [] as PromptInfo["parts"] },
              )
            })()
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              initialPrompt,
            })
            dialog.clear()
          },
        },
        {
          title: "Say Prompt",
          value: "message.say_prompt",
          description: "speak this message via TTS",
          onSelect: async (dialog) => {
            const text = userText()
            if (!text.trim()) return
            dialog.clear()
            await synthesizeAndPlay(text)
          },
        },
        {
          title: "Say Response",
          value: "message.say_response",
          description: "speak agent response (filtered) via TTS",
          onSelect: async (dialog) => {
            const text = filteredAssistantText()
            if (!text.trim()) {
              toast.show({ message: "No assistant response to speak yet", variant: "warning" })
              return
            }
            dialog.clear()
            await synthesizeAndPlay(text)
          },
        },
      ]}
    />
  )
}
