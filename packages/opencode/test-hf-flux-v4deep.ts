// Deep V4 test: fetch /config, find correct fn_index, build proper payload

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

async function main() {
  // 1. Fetch /config
  const configUrl = `${BASE_URL}/config`
  console.log(`Fetching config from ${configUrl}`)
  const configResp = await fetch(configUrl, { signal: AbortSignal.timeout(30_000) })
  console.log(`Config status: ${configResp.status}`)
  const config = await configResp.json()

  console.log(`\nConfig keys: ${Object.keys(config).join(", ")}`)
  console.log(`Dependencies count: ${config.dependencies?.length}`)
  console.log(`Components count: ${config.components?.length}`)

  // Print all dependencies
  console.log(`\n=== Dependencies ===`)
  for (const dep of config.dependencies || []) {
    console.log(JSON.stringify({
      id: dep.id,
      api_name: dep.api_name,
      inputs: dep.inputs,
      outputs: dep.outputs,
      trigger: dep.trigger,
    }))
  }

  // Find the dependency with api_name = "infer"
  const inferDep = config.dependencies?.find((d: any) => d.api_name === "infer")
  if (!inferDep) {
    console.log(`\nNo dependency with api_name="infer" found`)
    return
  }
  console.log(`\nFound infer dependency: id=${inferDep.id}`)

  // Build payload using components
  const comps = config.components as Array<Record<string, any>>
  const inputs = inferDep.inputs as number[]
  const data: any[] = []

  for (const cid of inputs) {
    const comp = comps.find((c: any) => c.id === cid)
    if (!comp) { data.push(null); continue }
    const type = comp.type || ""
    const props = comp.props || {}
    console.log(`Component ${cid}: type=${type}, props=${JSON.stringify(Object.keys(props))}`)

    if (type === "textbox" || type === "textarea") {
      data.push("a cat wearing a tiny hat")
    } else if (type === "slider" || type === "number") {
      data.push(props.value ?? 0)
    } else if (type === "checkbox") {
      data.push(props.value ?? false)
    } else {
      data.push(props.value ?? null)
    }
  }
  console.log(`\nBuilt payload: ${JSON.stringify(data)}`)

  // 2. Try /gradio_api/info for parameter names
  const infoUrl = `${BASE_URL}/gradio_api/info`
  const infoResp = await fetch(infoUrl, { signal: AbortSignal.timeout(30_000) })
  const info = await infoResp.json()
  const ep = info.named_endpoints?.["/infer"]
  console.log(`\nInfo endpoint /infer params: ${ep?.parameters?.map((p: any) => `${p.parameter_name}(${p.python_type?.type})=${p.parameter_default}`).join(", ")}`)

  // 3. Submit via queue/join with correct fn_index
  const sessionHash = Math.random().toString(36).substring(2, 15)
  const joinUrl = `${BASE_URL}/gradio_api/queue/join`
  const payload = {
    data,
    fn_index: inferDep.id,
    session_hash: sessionHash,
  }
  console.log(`\nSubmitting to ${joinUrl}`)
  console.log(`Payload: ${JSON.stringify(payload)}`)

  const joinResp = await fetch(joinUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  })
  console.log(`Join status: ${joinResp.status}`)
  const joinBody = await joinResp.json()
  console.log(`Join body: ${JSON.stringify(joinBody)}`)
  const eventId = joinBody.event_id

  // 4. Poll queue/data
  const dataUrl = `${BASE_URL}/gradio_api/queue/data?session_hash=${sessionHash}`
  console.log(`\nPolling ${dataUrl}`)
  const pollResp = await fetch(dataUrl, {
    signal: AbortSignal.timeout(120_000),
  })
  console.log(`Poll status: ${pollResp.status}`)

  if (!pollResp.ok || !pollResp.body) {
    console.log(`Poll failed`)
    return
  }

  const reader = pollResp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + 120_000

  while (Date.now() < deadline) {
    try {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data:")) continue
        const parsed = JSON.parse(line.slice(5).trim())
        console.log(`[SSE] ${parsed.msg}${parsed.event_id ? ` event_id=${parsed.event_id}` : ""}`)

        if (parsed.msg === "process_completed") {
          console.log(`\nResult: success=${parsed.success}`)
          console.log(`Output: ${JSON.stringify(parsed.output, null, 2).slice(0, 2000)}`)
          return
        }
        if (parsed.msg === "error") {
          console.log(`\nError: ${JSON.stringify(parsed, null, 2)}`)
          return
        }
      }
    } catch (e) {
      console.log(`Read error: ${e}`)
      break
    }
  }
  console.log(`\nPoll timeout`)
}

main().catch((e) => console.error("Unhandled:", e))
