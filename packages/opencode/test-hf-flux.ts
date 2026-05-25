// Standalone test script for hf-spaces.ts against real HF Space
// Run with: bun run test-hf-flux.ts

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

function isGradioV4(apiInfo: Record<string, unknown>): boolean {
  return Array.isArray(apiInfo.dependencies) && Array.isArray(apiInfo.components)
}

async function getApiInfo(spaceId: string, token?: string): Promise<Record<string, unknown> | null> {
  const url = `${spaceIdToUrl(spaceId)}/gradio_api/info`
  console.log(`\n=== Step 1: getApiInfo ===`)
  console.log(`URL: ${url}`)

  try {
    const resp = await fetch(url, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(30_000),
    })

    console.log(`Status: ${resp.status} ${resp.statusText}`)
    console.log(`Headers:`)
    resp.headers.forEach((v, k) => console.log(`  ${k}: ${v}`))

    const text = await resp.text()
    console.log(`Response body (first 2000 chars):`)
    console.log(text.slice(0, 2000))
    if (text.length > 2000) console.log(`... (${text.length - 2000} more chars)`)

    if (!resp.ok) {
      console.log(`\nERROR: getApiInfo returned non-OK status ${resp.status}`)
      return null
    }

    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch (e) {
      console.log(`\nERROR: Failed to parse JSON: ${e}`)
      return null
    }
  } catch (e) {
    console.log(`\nERROR: getApiInfo fetch failed: ${e}`)
    return null
  }
}

async function submitJob(spaceId: string, endpoint: string, data: unknown[], token?: string): Promise<string | null> {
  const url = `${spaceIdToUrl(spaceId)}/gradio_api/call${endpoint}`
  console.log(`\n  [submitJob] URL: ${url}`)
  console.log(`  [submitJob] Payload: ${JSON.stringify({ data }).slice(0, 500)}`)

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ data }),
      signal: AbortSignal.timeout(60_000),
    })
    console.log(`  [submitJob] Status: ${resp.status} ${resp.statusText}`)
    const text = await resp.text()
    console.log(`  [submitJob] Response: ${text.slice(0, 1000)}`)

    if (!resp.ok) {
      console.log(`  [submitJob] ERROR: submit failed with status ${resp.status}`)
      return null
    }
    const json = JSON.parse(text) as { event_id?: string }
    return json.event_id ?? null
  } catch (e) {
    console.log(`  [submitJob] ERROR: ${e}`)
    return null
  }
}

async function poll(spaceId: string, endpoint: string, eventId: string, token?: string): Promise<unknown[] | null> {
  const url = `${spaceIdToUrl(spaceId)}/gradio_api/call${endpoint}/${eventId}`
  console.log(`\n  [poll] URL: ${url}`)
  const deadline = Date.now() + 60_000

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(30_000),
      })
      if (!resp.ok || !resp.body) {
        console.log(`  [poll] Status: ${resp.status}, waiting...`)
        await sleep(3_000)
        continue
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          console.log(`  [poll] SSE line: ${line.slice(0, 200)}`)
          if (!line.startsWith("data:")) continue
          const payload = line.slice(5).trim()
          try {
            const parsed: unknown = JSON.parse(payload)
            if (Array.isArray(parsed)) return parsed
            if (parsed && typeof parsed === "object") {
              const p = parsed as Record<string, unknown>
              if ("error" in p) {
                console.log(`  [poll] ERROR from space: ${p.error}`)
                return null
              }
            }
          } catch (_) {}
        }
      }
    } catch (e) {
      console.log(`  [poll] ERROR: ${e}`)
    }
    await sleep(3_000)
  }

  console.log(`  [poll] TIMEOUT`)
  return null
}

async function submitV4(spaceId: string, fnIndex: number, data: unknown[], sessionHash: string, token?: string): Promise<string | null> {
  const url = `${spaceIdToUrl(spaceId)}/gradio_api/queue/join`
  console.log(`\n  [submitV4] URL: ${url}`)
  console.log(`  [submitV4] Payload: ${JSON.stringify({ data, fn_index: fnIndex, session_hash: sessionHash }).slice(0, 500)}`)

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ data, fn_index: fnIndex, session_hash: sessionHash }),
      signal: AbortSignal.timeout(60_000),
    })
    console.log(`  [submitV4] Status: ${resp.status} ${resp.statusText}`)
    const text = await resp.text()
    console.log(`  [submitV4] Response: ${text.slice(0, 1000)}`)

    if (!resp.ok) return null
    const json = JSON.parse(text) as { event_id?: string }
    return json.event_id ?? null
  } catch (e) {
    console.log(`  [submitV4] ERROR: ${e}`)
    return null
  }
}

async function pollV4(spaceId: string, sessionHash: string, token?: string): Promise<unknown[] | null> {
  const url = `${spaceIdToUrl(spaceId)}/gradio_api/queue/data?session_hash=${sessionHash}`
  console.log(`\n  [pollV4] URL: ${url}`)
  const deadline = Date.now() + 60_000

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(30_000),
      })
      if (!resp.ok || !resp.body) {
        console.log(`  [pollV4] Status: ${resp.status}, waiting...`)
        await sleep(3_000)
        continue
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) {
          console.log(`  [pollV4] SSE line: ${line.slice(0, 200)}`)
          if (!line.startsWith("data:")) continue
          try {
            const parsed = JSON.parse(line.slice(5).trim())
            console.log(`  [pollV4] Parsed msg: ${parsed.msg}`)
            if (parsed.msg === "process_completed") {
              if (!parsed.success) {
                console.log(`  [pollV4] ERROR: process_completed but success=false`)
                return null
              }
              const output = parsed.output?.data
              return Array.isArray(output) ? output : [output]
            }
          } catch {}
        }
      }
    } catch (e) {
      console.log(`  [pollV4] ERROR: ${e}`)
    }
    await sleep(3_000)
  }

  console.log(`  [pollV4] TIMEOUT`)
  return null
}

function buildV4Payload(apiInfo: Record<string, unknown>, depIdx: number, prompt?: string): unknown[] {
  const deps = apiInfo.dependencies as Array<Record<string, unknown>> | undefined
  const comps = apiInfo.components as Array<Record<string, unknown>> | undefined
  if (!deps || !comps) return []
  const dep = deps[depIdx]
  if (!dep) return []
  const inputs = (dep.inputs || []) as number[]
  const data: unknown[] = []
  for (const cId of inputs) {
    const comp = comps.find((c: Record<string, unknown>) => c.id === cId) as Record<string, unknown> | undefined
    if (!comp) { data.push(null); continue }
    const type = String(comp.type || "")
    const props = (comp.props || {}) as Record<string, unknown>
    if (type === "textbox" || type === "textarea") {
      data.push(prompt || props.value || "")
    } else if (type === "slider" || type === "number") {
      data.push(props.value ?? 0)
    } else if (type === "checkbox") {
      data.push(props.value ?? false)
    } else if (type === "dropdown" || type === "radio") {
      data.push(props.value ?? null)
    } else {
      data.push(props.value ?? null)
    }
  }
  return data
}

function buildPayloadV3(apiInfo: Record<string, unknown>, endpoint: string, prompt?: string): unknown[] {
  const named = apiInfo.named_endpoints as Record<string, { parameters?: Array<{ label?: string; python_type?: { type?: string }; parameter_default?: unknown }> }> | undefined
  const params = named?.[endpoint]?.parameters ?? []
  if (params.length === 0) return prompt ? [prompt] : []

  const data: unknown[] = []
  for (const param of params) {
    const type = (param.python_type?.type ?? "").toLowerCase()
    const label = (param.label ?? "").toLowerCase()
    if (["str", "text", "prompt", "string"].some((t) => type.includes(t) || label.includes(t))) {
      data.push(prompt || "")
    } else if (param.parameter_default !== undefined) {
      data.push(param.parameter_default)
    } else {
      data.push(null)
    }
  }
  return data
}

async function main() {
  console.log(`Testing HF Space: ${SPACE_ID}`)
  console.log(`Base URL: ${BASE_URL}`)

  const apiInfo = await getApiInfo(SPACE_ID)
  if (!apiInfo) {
    console.log(`\n=== ABORT: Could not fetch API info ===`)
    return
  }

  console.log(`\n=== Step 2: Detect Version ===`)
  const v4 = isGradioV4(apiInfo)
  console.log(`isGradioV4() = ${v4}`)

  if (v4) {
    console.log(`\n=== Step 3A: Gradio V4 Path ===`)
    const deps = apiInfo.dependencies as Array<Record<string, unknown>>
    console.log(`Dependencies count: ${deps.length}`)
    if (deps.length === 0) {
      console.log(`ERROR: No dependencies found`)
      return
    }
    const depIdx = 0
    const fnIndex = deps[depIdx].id as number
    console.log(`Using fn_index=${fnIndex}`)

    const sessionHash = Math.random().toString(36).substring(2, 15)
    const data = buildV4Payload(apiInfo, depIdx, "a cat wearing a tiny hat")
    console.log(`Built V4 payload: ${JSON.stringify(data).slice(0, 500)}`)

    const eventId = await submitV4(SPACE_ID, fnIndex, data, sessionHash)
    if (!eventId) {
      console.log(`\n=== V4 submit FAILED, attempting V3 fallback ===`)
    } else {
      console.log(`\n  [submitV4] Got event_id: ${eventId}`)
      const result = await pollV4(SPACE_ID, sessionHash)
      if (result) {
        console.log(`\n=== V4 SUCCESS ===`)
        console.log(JSON.stringify(result, null, 2).slice(0, 1000))
      } else {
        console.log(`\n=== V4 poll FAILED ===`)
      }
      return
    }
  }

  console.log(`\n=== Step 3B: Gradio V3 Path ===`)
  const named = Object.keys((apiInfo.named_endpoints as Record<string, unknown>) ?? {})
  console.log(`Named endpoints: ${named.join(", ") || "(none)"}`)

  const endpoint = named.length > 0 ? named[0] : "/predict"
  console.log(`Using endpoint: ${endpoint}`)

  const data = buildPayloadV3(apiInfo, endpoint, "a cat wearing a tiny hat")
  console.log(`Built V3 payload: ${JSON.stringify(data).slice(0, 500)}`)

  const eventId = await submitJob(SPACE_ID, endpoint, data)
  if (!eventId) {
    console.log(`\n=== V3 submit FAILED ===`)
    return
  }

  console.log(`\n  [submitJob] Got event_id: ${eventId}`)
  const result = await poll(SPACE_ID, endpoint, eventId)
  if (result) {
    console.log(`\n=== V3 SUCCESS ===`)
    console.log(JSON.stringify(result, null, 2).slice(0, 1000))
  } else {
    console.log(`\n=== V3 poll FAILED ===`)
  }
}

main().catch((e) => console.error("Unhandled error:", e))
