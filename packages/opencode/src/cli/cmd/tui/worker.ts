import { Log } from "@/util/log"
Log.silent()

import { Server } from "@/server/server"

import { getWorkingDirectory } from "@/util/working-directory"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import type { Event } from "@opencode-ai/sdk/v2"
import { Flag } from "@/flag/flag"
import { setTimeout as sleep } from "node:timers/promises"
import { writeHeapSnapshot } from "node:v8"

const onUnhandledRejection = (_error: unknown) => {}

const onUncaughtException = (_error: Error) => {}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

let bootstrapped = false

const bootstrapOnDemand = async (dir: string) => {
  if (bootstrapped) return
  bootstrapped = true
  await Instance.provide({ directory: dir, init: InstanceBootstrap, fn: () => {} }).catch(() => {})
}

const eventStream = {
  abort: undefined as AbortController | undefined,
}

const startEventStream = (input: { directory: string; workspaceID?: string }) => {
  if (eventStream.abort) eventStream.abort.abort()
  const abort = new AbortController()
  eventStream.abort = abort
  const signal = abort.signal

  ;(async () => {
    while (!signal.aborted) {
      const shouldReconnect = await Instance.provide({
        directory: input.directory,
        fn: () =>
          new Promise<boolean>((resolve) => {
            Rpc.emit("event", {
              type: "server.connected",
              properties: {},
            } satisfies Event)

            let settled = false
            const settle = (value: boolean) => {
              if (settled) return
              settled = true
              signal.removeEventListener("abort", onAbort)
              unsub()
              resolve(value)
            }

            const unsub = Bus.subscribeAll((event) => {
              Rpc.emit("event", event as Event)
              if (event.type === Bus.InstanceDisposed.type) {
                settle(true)
              }
            })

            const onAbort = () => {
              settle(false)
            }

            signal.addEventListener("abort", onAbort, { once: true })
          }),
      }).catch(() => false)

      if (!shouldReconnect || signal.aborted) {
        break
      }

      if (!signal.aborted) {
        await sleep(250)
      }
    }
  })().catch(() => {})
}

// Defer startEventStream so RPC listener is fully set up first
setTimeout(() => startEventStream({ directory: getWorkingDirectory() }), 0).unref?.()

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = getAuthorizationHeader()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await bootstrapOnDemand(input.directory)
    await upgrade().catch(() => {})
  },
  async reload() {
    await Config.invalidate(true)
  },
  async setWorkspace(input: { workspaceID?: string }) {
    startEventStream({ directory: getWorkingDirectory(), workspaceID: input.workspaceID })
  },
  async shutdown() {
    if (eventStream.abort) eventStream.abort.abort()
    await Instance.disposeAll()
    if (server) await server.stop(true)
  },
}

Rpc.listen(rpc)

function getAuthorizationHeader(): string | undefined {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${btoa(`${username}:${password}`)}`
}
