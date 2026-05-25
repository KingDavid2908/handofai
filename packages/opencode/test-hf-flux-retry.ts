// Quick retry to see if ZeroGPU error is transient

const SPACE_ID = "black-forest-labs/FLUX.1-schnell"
const BASE = (() => {
  const [owner, name] = SPACE_ID.split("/")
  return `https://${`${owner}-${name}`.toLowerCase().replace(/[_.]/g, "-")}.hf.space`
})()

async function main() {
  const sessionHash = Math.random().toString(36).substring(2, 15)
  const payload = {
    data: ["hello", 0, true, 256, 256, 1],
    fn_index: 2,
    session_hash: sessionHash,
  }

  console.log(`Submitting...`)
  const join = await fetch(`${BASE}/gradio_api/queue/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  })
  const { event_id } = await join.json()
  console.log(`event_id: ${event_id}`)

  const poll = await fetch(`${BASE}/gradio_api/queue/data?session_hash=${sessionHash}`, {
    signal: AbortSignal.timeout(120_000),
  })

  const reader = poll.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const p = JSON.parse(line.slice(5).trim())
      if (p.msg === "process_completed") {
        console.log(`SUCCESS=${p.success}`)
        console.log(JSON.stringify(p.output, null, 2))
        return
      }
      if (p.msg === "progress") process.stdout.write(".")
    }
  }
}

main().catch(console.error)
