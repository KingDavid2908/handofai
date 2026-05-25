// Extended test script for hf-spaces.ts against real HF Space
// Tests BOTH V3 and V4 paths regardless of detection

const SPACE_ID = "black-forest-labs/FLUX.1-schnell"
const BASE_URL = spaceIdToUrl(SPACE_ID)

function spaceIdToUrl(spaceId: string): string {
  const [owner, name] = spaceId.split("/")
  const slug = `${owner}-${name}`.toLowerCase().replace(/[_.]/g, "-")
  return `https://${slug}.hf.space`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function authHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" }
  if (token) h["Authorization"] = `Bearer ${token}`
  return h
}

async function getApiInfo(spaceId: string, token?: string): Promise<Record<string, unknown> | null> {
  const url = `${spaceIdToUrl(spaceId)}/gradio_api/info`
  console.log(`\n=== getApiInfo ===`)
  console.log(`URL: ${url}`)
  const resp = await fetch(url, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(30_000),
  })
  console.log(`Status: ${resp.status}`)
  const text = await resp.text()
  console.log(`Body (first 1500 chars): ${text.slice(0, 1500)}`)
  return resp.ok ? JSON.parse(text) : null
}

async function testV3(apiInfo: Record<string, unknown>) {
  console.log(`\n\n========== TESTING V3 PATH ==========`)
  const named = Object.keys((apiInfo.named_endpoints as Record<string, unknown>) ?? {})
  const endpoint = named.length > 0 ? named[0] : "/predict"
  console.log(`Endpoint: ${endpoint}`)

  const params = (apiInfo.named_endpoints as Record<string, { parameters?: Array<{ label?: string; python_type?: { type?: string }; parameter_default?: unknown }> }>)?.[endpoint]?.parameters ?? []
  const data = params.map((p) => {
    const type = (p.python_type?.type ?? "").toLowerCase()
    const label = (p.label ?? "").toLowerCase()
    if (["str", "text", "prompt", "string"].some((t) => type.includes(t) || label.includes(t))) return "a cat wearing a tiny hat"
    if (p.parameter_default !== undefined) return p.parameter_default
    return null
  })
  console.log(`Payload: ${JSON.stringify(data)}`)

  // Submit
  const submitUrl = `${spaceIdToUrl(SPACE_ID)}/gradio_api/call${endpoint}`
  console.log(`\n[V3 Submit] POST ${submitUrl}`)
  const submitResp = await fetch(submitUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(60_000),
  })
  console.log(`Status: ${submitResp.status}`)
  const submitText = await submitResp.text()
  console.log(`Body: ${submitText}`)
  if (!submitResp.ok) {
    console.log(`V3 SUBMIT FAILED`)
    return
  }
  const eventId = (JSON.parse(submitText) as { event_id?: string }).event_id
  console.log(`Got event_id: ${eventId}`)

  // Poll
  const pollUrl = `${spaceIdToUrl(SPACE_ID)}/gradio_api/call${endpoint}/${eventId}`
  console.log(`\n[V3 Poll] GET ${pollUrl}`)
  const pollResp = await fetch(pollUrl, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(120_000),
  })
  console.log(`Poll status: ${pollResp.status}`)
  if (!pollResp.ok || !pollResp.body) {
    console.log(`V3 POLL FAILED with status ${pollResp.status}`)
    return
  }

  const reader = pollResp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + 90_000

  while (Date.now() < deadline) {
    try {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        console.log(`[V3 SSE] ${line.slice(0, 200)}`)
        if (!line.startsWith("data:")) continue
        const payload = line.slice(5).trim()
        try {
          const parsed = JSON.parse(payload)
          if (Array.isArray(parsed)) {
            console.log(`\n=== V3 SUCCESS ===`)
            console.log(JSON.stringify(parsed, null, 2).slice(0, 1000))
            return
          }
          if (parsed && typeof parsed === "object" && "error" in parsed) {
            console.log(`\n=== V3 ERROR from stream ===`)
            console.log(parsed.error)
            return
          }
        } catch {}
      }
    } catch (e) {
      console.log(`[V3 Poll read error] ${e}`)
      break
    }
  }
  console.log(`\n=== V3 POLL TIMEOUT or STREAM END ===`)
}

async function testV4(apiInfo: Record<string, unknown>) {
  console.log(`\n\n========== TESTING V4 PATH ==========`)

  // Try to fetch config.json which has dependencies and components
  const configUrl = `${spaceIdToUrl(SPACE_ID)}/config`
  console.log(`\n[V4 Config] GET ${configUrl}`)
  const configResp = await fetch(configUrl, { signal: AbortSignal.timeout(30_000) })
  console.log(`Status: ${configResp.status}`)
  if (configResp.ok) {
    const configText = await configResp.text()
    console.log(`Body (first 1500 chars): ${configText.slice(0, 1500)}`)
    try {
      const config = JSON.parse(configText)
      if (Array.isArray(config.dependencies) && Array.isArray(config.components)) {
        console.log(`Config has dependencies (${config.dependencies.length}) and components (${config.components.length}) — this is V4-style`)
      }
    } catch {}
  }

  // Also try the info endpoint with ?serialize=true or /gradio_api/info?serialize=True
  const infoUrl2 = `${spaceIdToUrl(SPACE_ID)}/gradio_api/info?serialize=True`
  console.log(`\n[V4 Info] GET ${infoUrl2}`)
  const info2Resp = await fetch(infoUrl2, { signal: AbortSignal.timeout(30_000) })
  console.log(`Status: ${info2Resp.status}`)
  if (info2Resp.ok) {
    const text = await info2Resp.text()
    console.log(`Body (first 1500 chars): ${text.slice(0, 1500)}`)
  }

  // Try queue/join with guessed fn_index=0
  const sessionHash = Math.random().toString(36).substring(2, 15)
  const data = ["a cat wearing a tiny hat", 0, true, 1024, 1024, 4]

  const joinUrl = `${spaceIdToUrl(SPACE_ID)}/gradio_api/queue/join`
  console.log(`\n[V4 Submit] POST ${joinUrl}`)
  console.log(`Payload: ${JSON.stringify({ data, fn_index: 0, session_hash: sessionHash })}`)
  const joinResp = await fetch(joinUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ data, fn_index: 0, session_hash: sessionHash }),
    signal: AbortSignal.timeout(60_000),
  })
  console.log(`Status: ${joinResp.status}`)
  const joinText = await joinResp.text()
  console.log(`Body: ${joinText}`)
  if (!joinResp.ok) {
    console.log(`V4 SUBMIT FAILED`)
    return
  }
  const eventId = (JSON.parse(joinText) as { event_id?: string }).event_id
  console.log(`Got event_id: ${eventId}`)

  // Poll queue/data
  const dataUrl = `${spaceIdToUrl(SPACE_ID)}/gradio_api/queue/data?session_hash=${sessionHash}`
  console.log(`\n[V4 Poll] GET ${dataUrl}`)
  const dataResp = await fetch(dataUrl, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(120_000),
  })
  console.log(`Status: ${dataResp.status}`)
  if (!dataResp.ok || !dataResp.body) {
    console.log(`V4 POLL FAILED with status ${dataResp.status}`)
    return
  }

  const reader = dataResp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + 90_000

  while (Date.now() < deadline) {
    try {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        console.log(`[V4 SSE] ${line.slice(0, 200)}`)
        if (!line.startsWith("data:")) continue
        try {
          const parsed = JSON.parse(line.slice(5).trim())
          console.log(`[V4 msg] ${parsed.msg}`)
          if (parsed.msg === "process_completed") {
            if (!parsed.success) {
              console.log(`\n=== V4 ERROR: success=false ===`)
              console.log(JSON.stringify(parsed, null, 2).slice(0, 1000))
              return
            }
            const output = parsed.output?.data
            console.log(`\n=== V4 SUCCESS ===`)
            console.log(JSON.stringify(output, null, 2).slice(0, 1000))
            return
          }
          if (parsed.msg === "error") {
            console.log(`\n=== V4 ERROR msg ===`)
            console.log(JSON.stringify(parsed, null, 2).slice(0, 1000))
            return
          }
        } catch {}
      }
    } catch (e) {
      console.log(`[V4 Poll read error] ${e}`)
      break
    }
  }
  console.log(`\n=== V4 POLL TIMEOUT or STREAM END ===`)
}

async function main() {
  console.log(`Testing HF Space: ${SPACE_ID}`)
  const apiInfo = await getApiInfo(SPACE_ID)
  if (!apiInfo) {
    console.log(`Could not fetch API info`)
    return
  }

  console.log(`\n=== API Info keys ===`)
  console.log(Object.keys(apiInfo).join(", "))

  if (apiInfo.named_endpoints) {
    console.log(`\nNamed endpoints: ${Object.keys(apiInfo.named_endpoints as Record<string, unknown>).join(", ")}`)
  }

  await testV3(apiInfo)
  await testV4(apiInfo)
}

main().catch((e) => console.error("Unhandled:", e))
