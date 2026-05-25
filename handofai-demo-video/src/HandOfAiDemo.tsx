import { useCurrentFrame, interpolate, spring, useVideoConfig, Audio, Sequence, staticFile } from "remotion"
import { useAudioData, visualizeAudio } from "@remotion/media-utils"
import { useMemo } from "react"

const BG = "#0d1117"
const TERMINAL_BG = "#161b22"
const GREEN = "#3fb950"
const CYAN = "#58a6ff"
const BRAND = "#007AFF"
const ORANGE = "#d29922"
const RED = "#f85149"
const PURPLE = "#bc8cff"
const TEXT = "#e6edf3"
const DIM = "#8b949e"
const BORDER = "#30363d"
const BRAND_DIM = "#007AFF44"

const W = 1920
const H = 1080
const FONT = "'Courier New', 'Consolas', monospace"

const SCENES = [
  { name: "intro", start: 0, dur: 400 },
  { name: "code", start: 400, dur: 600 },
  { name: "media", start: 1000, dur: 540 },
  { name: "search", start: 1540, dur: 480 },
  { name: "action", start: 2020, dur: 540 },
  { name: "sight", start: 2560, dur: 360 },
  { name: "memory", start: 2920, dur: 420 },
  { name: "automation", start: 3340, dur: 420 },
  { name: "safety", start: 3760, dur: 300 },
  { name: "outro", start: 4060, dur: 440 },
]

function getScene(f: number) {
  for (const s of SCENES) {
    if (f >= s.start && f < s.start + s.dur) return s
  }
  return SCENES[SCENES.length - 1]
}

function sceneFrame(f: number, s: typeof SCENES[0]) {
  return f - s.start
}

function opacity(f: number, s: typeof SCENES[0], fadeIn = 15, fadeOut = 15) {
  const local = sceneFrame(f, s)
  if (local < fadeIn) return local / fadeIn
  if (local > s.dur - fadeOut) return Math.max(0, (s.dur - local) / fadeOut)
  return 1
}

function typewriter(text: string, chars: number) {
  return text.slice(0, Math.max(0, Math.min(chars, text.length)))
}

function Box({ children, x, y, w: bw, h: bh }: { children: React.ReactNode; x: number; y: number; w: number; h: number }) {
  return (
    <div style={{ position: "absolute", left: x, top: y, width: bw, height: bh, backgroundColor: TERMINAL_BG, border: `1px solid ${BORDER}`, borderRadius: 8, overflow: "hidden", fontFamily: FONT, fontSize: 18, color: TEXT }}>
      <div style={{ height: 32, backgroundColor: "#21262d", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", padding: "0 14px", gap: 8 }}>
        <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: RED }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: ORANGE }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: GREEN }} />
        <div style={{ flex: 1 }} />
        <span style={{ color: DIM, fontSize: 13 }}>handofai@agent:~</span>
      </div>
      <div style={{ padding: "16px 20px", lineHeight: 1.6 }}>{children}</div>
    </div>
  )
}

function HandIcon({ name, icon }: { name: string; icon: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ width: 52, height: 52, borderRadius: "50%", backgroundColor: BRAND + "22", border: `2px solid ${BRAND}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, color: BRAND, fontFamily: FONT }}>{icon}</div>
      <span style={{ fontSize: 28, fontWeight: "bold", color: TEXT, fontFamily: FONT }}>{name}</span>
    </div>
  )
}

function SceneTitle({ title, subtitle, frame, start, dur }: { title: string; subtitle: string; frame: number; start: number; dur: number }) {
  const local = frame - start
  const op = interpolate(local, [0, 20, dur - 20, dur], [0, 1, 1, 0])
  const t = typewriter(title, Math.floor(local * 1.5))
  return (
    <div style={{ opacity: op, textAlign: "center", marginTop: 60 }}>
      <h1 style={{ fontSize: 48, color: BRAND, fontFamily: FONT, margin: 0 }}>{t}</h1>
      <p style={{ fontSize: 20, color: DIM, fontFamily: FONT, marginTop: 12 }}>{subtitle}</p>
    </div>
  )
}

function FeatureLine({ text, idx, local }: { text: string; idx: number; local: number }) {
  const revealAt = 20 + idx * 8
  const chars = Math.max(0, local - revealAt) * 3
  const shown = typewriter(text, chars)
  const op = local >= revealAt ? 1 : 0
  return (
    <div style={{ opacity: op, color: TEXT, fontFamily: FONT, fontSize: 20, marginBottom: 12, paddingLeft: 24 }}>
      <span style={{ color: BRAND }}>◆ </span>{shown}
      {chars < text.length && chars > 0 && <span style={{ color: GREEN }}>▌</span>}
    </div>
  )
}

function BrandBar() {
  return <div style={{ position: "absolute", top: 0, left: 0, width: W, height: 4, backgroundColor: BRAND, opacity: 0.8 }} />
}

function Waveform({ src, frame, start, dur }: { src: string; frame: number; start: number; dur: number }) {
  const local = frame - start
  const audioData = useAudioData(src)
  const freq = useMemo(() => {
    if (!audioData) return new Array(64).fill(0)
    const v = visualizeAudio({ audioData, frame: local, fps: 30, numberOfSamples: 64 })
    return v
  }, [audioData, local])

  if (!audioData || local < 0 || local > dur) return null

  return (
    <div style={{ position: "absolute", bottom: 20, left: 120, width: 1680, height: 50, display: "flex", alignItems: "center", gap: 2, opacity: 0.5 }}>
      {freq.map((val, i) => (
        <div key={i} style={{ width: 22, height: Math.max(2, val * 50), backgroundColor: BRAND, borderRadius: 2, minHeight: 2 }} />
      ))}
    </div>
  )
}

function IntroScene({ f }: { f: number }) {
  const s = SCENES[0]
  const local = sceneFrame(f, s)
  const op = opacity(f, s)
  const line1 = typewriter("What if any AI model could reach out and touch the world?", Math.floor(local * 1.2))
  const line1Done = line1.length >= "What if any AI model could reach out and touch the world?".length
  const line2Progress = line1Done ? Math.max(0, local - 50) : 0
  const line2 = typewriter("Not just to type. To create. To act.", Math.floor(line2Progress * 1.5))
  const line2Done = line2.length >= "Not just to type. To create. To act.".length
  const logoProgress = line2Done ? spring({ frame: local - 110, fps: 30, config: { damping: 12 } }) : 0
  return (
    <div style={{ opacity: op, position: "relative", width: W, height: H, backgroundColor: BG, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <BrandBar />
      <div style={{ fontFamily: FONT, fontSize: 36, color: GREEN, textAlign: "center", minHeight: 180 }}>
        <div style={{ marginBottom: 24 }}>
          {'$>'} <span style={{ color: TEXT }}>{line1}</span>
          {!line1Done && <span style={{ color: GREEN }}>▌</span>}
        </div>
        {line1Done && (
          <div style={{ fontSize: 22, color: DIM }}>
            {'$>'} <span style={{ color: TEXT }}>{line2}</span>
            {!line2Done && <span style={{ color: GREEN }}>▌</span>}
          </div>
        )}
      </div>
      {line2Done && (
        <div style={{ transform: `scale(${logoProgress})`, textAlign: "center", marginTop: 40 }}>
          <div style={{ fontSize: 72, fontWeight: "bold", color: BRAND, fontFamily: FONT }}>handofai</div>
          <div style={{ fontSize: 20, color: GREEN, fontFamily: FONT, marginTop: 8 }}>Giving AI Models Hands</div>
        </div>
      )}
    </div>
  )
}

function CodeScene({ f }: { f: number }) {
  const s = SCENES[1]
  const local = sceneFrame(f, s)
  const op = opacity(f, s)
  const features = ["Write & execute any TypeScript — filesystem, HTTP, shell, all in one sandbox", "Install any npm library at runtime — no pre-installed deps needed", "Call any REST API with built-in tools.api client", "Run code in Docker, over SSH, or with PTY for interactive CLIs", "Spawn & manage background processes — servers, watchers, anything", "Create persistent custom tools — write once, use forever"]
  return (
    <div style={{ opacity: op, position: "relative", width: W, height: H, backgroundColor: BG, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <BrandBar />
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 50 }}><HandIcon name="Hand of Code" icon="TS" /></div>
      <SceneTitle title="# TypeScript Tool" subtitle="The universal crafting hand — write anything, run anywhere" frame={f} start={s.start} dur={s.dur} />
      <Box x={240} y={280} w={1440} h={400}>
        <div style={{ color: BRAND, marginBottom: 8 }}>$ typescript --code "fetch data, write files, call APIs"</div>
        {features.map((feat, i) => (<FeatureLine key={i} text={feat} idx={i} local={local} />))}
      </Box>
      <div style={{ position: "absolute", bottom: 100, fontFamily: FONT, fontSize: 14, color: DIM }}>▸ Bun sandbox · AsyncFunction execution · Docker/SSH backends · Process registry</div>
      <Waveform src={staticFile("code.mp3")} frame={f} start={s.start} dur={s.dur} />
    </div>
  )
}

function MediaScene({ f }: { f: number }) {
  const s = SCENES[2]
  const local = sceneFrame(f, s)
  const op = opacity(f, s)
  const features = ["Generate videos programmatically with Remotion — React → MP4", "Convert & analyze media with ffmpeg — any format, any codec", "Generate images, remove backgrounds, upscale — 14 HF Space categories", "Synthesize speech, transcribe audio, compose music — all via HF Spaces", "Guided decision tree — knows when to use media vs typescript tool", "Curated registry of top Hugging Face Spaces, auto-updatable"]
  return (
    <div style={{ opacity: op, position: "relative", width: W, height: H, backgroundColor: BG, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <BrandBar />
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 50 }}><HandIcon name="Hand of Media" icon="🎬" /></div>
      <SceneTitle title="# Media Tool" subtitle="The creative hand — generate images, video, audio, and more" frame={f} start={s.start} dur={s.dur} />
      <Box x={240} y={280} w={1440} h={400}>
        <div style={{ color: BRAND, marginBottom: 8 }}>$ media create_video --name MyAnimation --prompt "..."</div>
        {features.map((feat, i) => (<FeatureLine key={i} text={feat} idx={i} local={local} />))}
      </Box>
      <div style={{ position: "absolute", bottom: 100, fontFamily: FONT, fontSize: 14, color: DIM }}>▸ Remotion · ffmpeg · Hugging Face Spaces · 14 curated categories · Studio preview</div>
      <Waveform src={staticFile("media.mp3")} frame={f} start={s.start} dur={s.dur} />
    </div>
  )
}

function SearchScene({ f }: { f: number }) {
  const s = SCENES[3]
  const local = sceneFrame(f, s)
  const op = opacity(f, s)
  const features = ["WebFetch: 4-provider fallback chain — Direct → TinyFish → Tavily → Firecrawl", "Cloudflare detection bypass — auto-retries with alternate user-agent", "Auto-image detection — returns base64 data URIs for images", "WebSearch: Exa MCP deep search with livecrawl modes", "CodeSearch: SDK & API docs via Exa — 1,000 to 50,000 token context", "Auto year injection — searches stay current without manual updates"]
  return (
    <div style={{ opacity: op, position: "relative", width: W, height: H, backgroundColor: BG, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <BrandBar />
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 50 }}><HandIcon name="Hand of Search" icon="🌐" /></div>
      <SceneTitle title="# Web Tools" subtitle="The reaching hand — fetch any URL, search any topic" frame={f} start={s.start} dur={s.dur} />
      <Box x={240} y={280} w={1440} h={400}>
        <div style={{ color: BRAND, marginBottom: 8 }}>$ webfetch https://example.com --format markdown</div>
        {features.map((feat, i) => (<FeatureLine key={i} text={feat} idx={i} local={local} />))}
      </Box>
      <div style={{ position: "absolute", bottom: 100, fontFamily: FONT, fontSize: 14, color: DIM }}>▸ Direct fetch · TinyFish · Tavily · Firecrawl · Exa MCP · Cloudflare bypass</div>
      <Waveform src={staticFile("search.mp3")} frame={f} start={s.start} dur={s.dur} />
    </div>
  )
}

function ActionScene({ f }: { f: number }) {
  const s = SCENES[4]
  const local = sceneFrame(f, s)
  const op = opacity(f, s)
  const features = ["Execute commands locally, in Docker sandboxes, or over SSH — 3 backends", "Docker: cap-drop ALL, no-new-privileges, pids-limit 256 — hardened execution", "SSH: ControlMaster multiplexing with connection reuse", "PTY mode: interactive CLI tools — REPLs, vim, htop via node-pty", "Persistent shell: stateful sessions across calls — variables, cd persist", "Background processes: servers, watchers — poll, wait, kill with session tracking"]
  return (
    <div style={{ opacity: op, position: "relative", width: W, height: H, backgroundColor: BG, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <BrandBar />
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 50 }}><HandIcon name="Hand of Action" icon="⚡" /></div>
      <SceneTitle title="# Multi-Backend Bash" subtitle="The action hand — run anywhere, any environment" frame={f} start={s.start} dur={s.dur} />
      <Box x={240} y={280} w={1440} h={400}>
        <div style={{ color: BRAND, marginBottom: 8 }}>$ bash --backend docker --description "Build and test"</div>
        {features.map((feat, i) => (<FeatureLine key={i} text={feat} idx={i} local={local} />))}
      </Box>
      <div style={{ position: "absolute", bottom: 100, fontFamily: FONT, fontSize: 14, color: DIM }}>▸ Local · Docker · SSH · PTY · Persistent shell · Background processes · Sudo injection</div>
      <Waveform src={staticFile("action.mp3")} frame={f} start={s.start} dur={s.dur} />
    </div>
  )
}

function SightScene({ f }: { f: number }) {
  const s = SCENES[5]
  const local = sceneFrame(f, s)
  const op = opacity(f, s)
  const features = ["Autonomous browser automation — natural language task → browser does it", "NanoBrowser Chrome extension — real browser control, not headless", "Vision tool: analyze images, videos, and audio with a dedicated model", "SSRF protection: DNS-based private IP detection blocks internal hosts", "Auto-attachment detection — finds latest media in conversation", "Multi-modal: images, video, audio — all through one tool call"]
  return (
    <div style={{ opacity: op, position: "relative", width: W, height: H, backgroundColor: BG, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <BrandBar />
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 50 }}><HandIcon name="Hand of Sight" icon="👁️" /></div>
      <SceneTitle title="# Browser + Vision" subtitle="The seeing hand — browse the web, see the world" frame={f} start={s.start} dur={s.dur} />
      <Box x={240} y={280} w={1440} h={400}>
        <div style={{ color: BRAND, marginBottom: 8 }}>$ browser --task "Find the cheapest wireless mouse"</div>
        {features.map((feat, i) => (<FeatureLine key={i} text={feat} idx={i} local={local} />))}
      </Box>
      <div style={{ position: "absolute", bottom: 100, fontFamily: FONT, fontSize: 14, color: DIM }}>▸ NanoBrowser · Vision model · SSRF protection · Auto-attachment · Multi-modal</div>
      <Waveform src={staticFile("sight.mp3")} frame={f} start={s.start} dur={s.dur} />
    </div>
  )
}

function MemoryScene({ f }: { f: number }) {
  const s = SCENES[6]
  const local = sceneFrame(f, s)
  const op = opacity(f, s)
  const features = ["Two-layer memory: local markdown files + API-backed remote (Supermemory & Graphlit)", "Cross-session search — full-text search across every past conversation", "Nudge system: background agent auto-extracts user preferences after sessions", "Multi-modal memory: save text, images, video, audio, documents", "Granular control: choose which backend per save — local, Supermemory, or Graphlit", "Content security scanning — blocks prompt injection and invisible unicode"]
  return (
    <div style={{ opacity: op, position: "relative", width: W, height: H, backgroundColor: BG, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <BrandBar />
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 50 }}><HandIcon name="Hand of Memory" icon="🧠" /></div>
      <SceneTitle title="# Memory System" subtitle="The remembering hand — never forgets, always learns" frame={f} start={s.start} dur={s.dur} />
      <Box x={240} y={280} w={1440} h={400}>
        <div style={{ color: BRAND, marginBottom: 8 }}>$ session_search --query "What did we discuss?"</div>
        {features.map((feat, i) => (<FeatureLine key={i} text={feat} idx={i} local={local} />))}
      </Box>
      <div style={{ position: "absolute", bottom: 100, fontFamily: FONT, fontSize: 14, color: DIM }}>▸ Local · Supermemory · Graphlit · Nudge · Sessions · Lessons · Security scanning</div>
      <Waveform src={staticFile("memory.mp3")} frame={f} start={s.start} dur={s.dur} />
    </div>
  )
}

function AutomationScene({ f }: { f: number }) {
  const s = SCENES[7]
  const local = sceneFrame(f, s)
  const op = opacity(f, s)
  const features = ["Cron scheduler: schedule autonomous tasks — human-readable or cron expressions", "14 delivery targets: Telegram, Discord, Slack, WhatsApp, Signal, email, SMS & more", "Skills system: load domain-specific workflows — weather, media, memory control", "Skills Guard: 100+ threat patterns, 3 trust levels, policy-based auto-allow/block", "Plugin system: install npm plugins with automatic config patching", "Discover: custom tools hidden until activated — write your own TS tools"]
  return (
    <div style={{ opacity: op, position: "relative", width: W, height: H, backgroundColor: BG, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <BrandBar />
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 50 }}><HandIcon name="Hand of Automation" icon="⏰" /></div>
      <SceneTitle title="# Cron + Skills + Plugins" subtitle="The tireless hand — works while you sleep" frame={f} start={s.start} dur={s.dur} />
      <Box x={240} y={280} w={1440} h={400}>
        <div style={{ color: BRAND, marginBottom: 8 }}>$ cron create --schedule "every 2h" --deliver discord</div>
        {features.map((feat, i) => (<FeatureLine key={i} text={feat} idx={i} local={local} />))}
      </Box>
      <div style={{ position: "absolute", bottom: 100, fontFamily: FONT, fontSize: 14, color: DIM }}>▸ Cron scheduler · 14 delivery targets · Skills system · Plugins · Custom tools</div>
      <Waveform src={staticFile("automation.mp3")} frame={f} start={s.start} dur={s.dur} />
    </div>
  )
}

function SafetyScene({ f }: { f: number }) {
  const s = SCENES[8]
  const local = sceneFrame(f, s)
  const op = opacity(f, s)
  const features = ["Dangerous command approval — 32 patterns (fork bomb, rm -rf, format, etc.)", "Permanent allowlist: saved to disk, survives restarts", "Secret output redaction — 7 pattern detectors (API keys, tokens, private keys)", "Read loop detection: blocks agents stuck reading the same file 4+ times", "Skills Guard: security scanner with 13 threat categories", "Sudo handling: auto-inject password via SUDO_PASSWORD env var"]
  return (
    <div style={{ opacity: op, position: "relative", width: W, height: H, backgroundColor: BG, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <BrandBar />
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 50 }}><HandIcon name="Hand of Safety" icon="🛡️" /></div>
      <SceneTitle title="# Safety Systems" subtitle="The guarding hand — powerful, not dangerous" frame={f} start={s.start} dur={s.dur} />
      <Box x={240} y={280} w={1440} h={400}>
        <div style={{ color: RED, marginBottom: 8 }}>$ bash --description "rm -rf /"  {'⚠'} BLOCKED</div>
        {features.map((feat, i) => (<FeatureLine key={i} text={feat} idx={i} local={local} />))}
      </Box>
      <div style={{ position: "absolute", bottom: 100, fontFamily: FONT, fontSize: 14, color: DIM }}>▸ 32 danger patterns · Secret redaction · Read loop detection · Skills guard · Sudo</div>
      <Waveform src={staticFile("safety.mp3")} frame={f} start={s.start} dur={s.dur} />
    </div>
  )
}

function OutroScene({ f }: { f: number }) {
  const s = SCENES[9]
  const local = sceneFrame(f, s)
  const fadeIn = spring({ frame: local, fps: 30, config: { damping: 14 } })
  const fadeOut = local > s.dur - 60 ? interpolate(s.dur - local, [0, 60], [0, 1]) : 1
  return (
    <div style={{ opacity: fadeOut, position: "relative", width: W, height: H, backgroundColor: BG, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <BrandBar />
      <div style={{ transform: `scale(${fadeIn})`, textAlign: "center" }}>
        <div style={{ fontSize: 72, fontWeight: "bold", color: BRAND, fontFamily: FONT, marginBottom: 16 }}>handofai</div>
        <div style={{ fontSize: 28, color: GREEN, fontFamily: FONT, marginBottom: 40 }}>Giving AI Models Hands</div>
        <div style={{ width: 200, height: 2, backgroundColor: BORDER, margin: "0 auto 40px" }} />
        <div style={{ fontSize: 18, color: DIM, fontFamily: FONT, lineHeight: 2 }}>
          <div style={{ color: BRAND }}>$ typescript -- build anything</div>
          <div style={{ color: GREEN }}>$ media -- create anything</div>
          <div style={{ color: CYAN }}>$ search -- find anything</div>
          <div style={{ color: ORANGE }}>$ bash -- do anything</div>
          <div style={{ color: PURPLE }}>$ memory -- remember everything</div>
        </div>
        {local > 200 && <div style={{ marginTop: 60, fontSize: 16, color: DIM, fontFamily: FONT }}><span style={{ color: GREEN }}>▌</span></div>}
      </div>
      <Waveform src={staticFile("outro.mp3")} frame={f} start={s.start} dur={s.dur} />
    </div>
  )
}

export const HandOfAiDemo = () => {
  const f = useCurrentFrame()

  return (
    <>
      <Audio src={staticFile("bgm.mp3")} volume={(x) => {
        const fadeIn = Math.min(1, x / 60)
        const fadeOut = f > 4200 ? interpolate(4500 - f, [0, 300], [0, 1]) : 1
        return 0.25 * fadeIn * fadeOut
      }} loop />

      <Sequence from={SCENES[0].start} durationInFrames={SCENES[0].dur}>
        <Audio src={staticFile("intro.mp3")} />
        <IntroScene f={f} />
      </Sequence>

      <Sequence from={SCENES[1].start} durationInFrames={SCENES[1].dur}>
        <Audio src={staticFile("code.mp3")} />
        <CodeScene f={f} />
      </Sequence>

      <Sequence from={SCENES[2].start} durationInFrames={SCENES[2].dur}>
        <Audio src={staticFile("media.mp3")} />
        <MediaScene f={f} />
      </Sequence>

      <Sequence from={SCENES[3].start} durationInFrames={SCENES[3].dur}>
        <Audio src={staticFile("search.mp3")} />
        <SearchScene f={f} />
      </Sequence>

      <Sequence from={SCENES[4].start} durationInFrames={SCENES[4].dur}>
        <Audio src={staticFile("action.mp3")} />
        <ActionScene f={f} />
      </Sequence>

      <Sequence from={SCENES[5].start} durationInFrames={SCENES[5].dur}>
        <Audio src={staticFile("sight.mp3")} />
        <SightScene f={f} />
      </Sequence>

      <Sequence from={SCENES[6].start} durationInFrames={SCENES[6].dur}>
        <Audio src={staticFile("memory.mp3")} />
        <MemoryScene f={f} />
      </Sequence>

      <Sequence from={SCENES[7].start} durationInFrames={SCENES[7].dur}>
        <Audio src={staticFile("automation.mp3")} />
        <AutomationScene f={f} />
      </Sequence>

      <Sequence from={SCENES[8].start} durationInFrames={SCENES[8].dur}>
        <Audio src={staticFile("safety.mp3")} />
        <SafetyScene f={f} />
      </Sequence>

      <Sequence from={SCENES[9].start} durationInFrames={SCENES[9].dur}>
        <Audio src={staticFile("outro.mp3")} />
        <OutroScene f={f} />
      </Sequence>
    </>
  )
}
