import { Effect, Layer, ServiceMap } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { MemoryStore } from "./memory-store"
import { MemoryNudge } from "./nudge"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
import type { SessionID } from "@/session/schema"

export namespace MemoryService {
  const log = Log.create({ service: "memory.service" })

  export interface Snapshot {
    memory: string
    user: string
    memoryUsage: { used: number; limit: number; percent: number }
    userUsage: { used: number; limit: number; percent: number }
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly load: () => Effect.Effect<void>
    readonly getSnapshot: () => Effect.Effect<Snapshot | null>
    readonly add: (target: "memory" | "user", content: string) => Effect.Effect<{ success: boolean; error?: string; usage?: string }>
    readonly replace: (target: "memory" | "user", oldText: string, content: string) => Effect.Effect<{ success: boolean; error?: string; usage?: string }>
    readonly remove: (target: "memory" | "user", oldText: string) => Effect.Effect<{ success: boolean; error?: string; usage?: string }>
    readonly clear: (target: "memory" | "user") => Effect.Effect<void>
    readonly reload: () => Effect.Effect<void>
    readonly incrementTurn: (sessionID: SessionID) => Effect.Effect<void>
    readonly checkNudge: (sessionID: SessionID) => Effect.Effect<boolean>
    readonly incrementSkillTurns: (sessionID: SessionID) => Effect.Effect<void>
    readonly checkSkillNudge: (sessionID: SessionID) => Effect.Effect<boolean>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/MemoryService") {}

  export const layer: Layer.Layer<Service, never, Config.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service

      const init = Effect.fn("MemoryService.init")(function* () {
        const cfg = yield* config.get()
        const memoryConfig = cfg.memory
        if (memoryConfig && "enabled" in memoryConfig && memoryConfig.enabled === false) return
        yield* Effect.promise(() => MemoryStore.init())
      })

      const load = Effect.fn("MemoryService.load")(function* () {
        yield* Effect.promise(() => MemoryStore.load())
      })

      const getSnapshot = Effect.fn("MemoryService.getSnapshot")(function* () {
        if (!MemoryStore.isInitialized()) return null
        const snapshot = MemoryStore.getSnapshot()
        if (!snapshot) return null
        return {
          memory: snapshot.memory,
          user: snapshot.user,
          memoryUsage: snapshot.memoryUsage,
          userUsage: snapshot.userUsage,
        }
      })

      const add = Effect.fn("MemoryService.add")(function* (target: "memory" | "user", content: string) {
        const result = yield* Effect.promise(() => MemoryStore.add(target, content))
        return { success: result.success, error: result.error, usage: result.usage }
      })

      const replace = Effect.fn("MemoryService.replace")(function* (target: "memory" | "user", oldText: string, content: string) {
        const result = yield* Effect.promise(() => MemoryStore.replace(target, oldText, content))
        return { success: result.success, error: result.error, usage: result.usage }
      })

      const remove = Effect.fn("MemoryService.remove")(function* (target: "memory" | "user", oldText: string) {
        const result = yield* Effect.promise(() => MemoryStore.remove(target, oldText))
        return { success: result.success, error: result.error, usage: result.usage }
      })

      const clear = Effect.fn("MemoryService.clear")(function* (target: "memory" | "user") {
        yield* Effect.promise(() => MemoryStore.clear(target))
      })

      const reload = Effect.fn("MemoryService.reload")(function* () {
        yield* Effect.promise(() => MemoryStore.load())
        log.info("reloaded memory snapshots from disk")
      })

      const incrementTurn = Effect.fn("MemoryService.incrementTurn")(function* (sessionID: SessionID) {
        MemoryNudge.incrementTurn(sessionID)
      })

      const checkNudge = Effect.fn("MemoryService.checkNudge")(function* (sessionID: SessionID) {
        const cfg = yield* config.get()
        const nudgeInterval = cfg.memory?.nudge_interval ?? 10
        return MemoryNudge.shouldTrigger(sessionID, nudgeInterval)
      })

      const incrementSkillTurns = Effect.fn("MemoryService.incrementSkillTurns")(function* (sessionID: SessionID) {
        MemoryNudge.incrementSkillTurns(sessionID)
      })

      const checkSkillNudge = Effect.fn("MemoryService.checkSkillNudge")(function* (sessionID: SessionID) {
        const cfg = yield* config.get()
        const interval = cfg.memory?.skill_creation_nudge_interval ?? 10
        return MemoryNudge.shouldTriggerSkillReview(sessionID, interval)
      })

      return Service.of({
        init,
        load,
        getSnapshot,
        add,
        replace,
        remove,
        clear,
        reload,
        incrementTurn,
        checkNudge,
        incrementSkillTurns,
        checkSkillNudge,
      })
    }),
  ).pipe(Layer.orDie)

  export const defaultLayer = layer.pipe(
    Layer.provide(Config.defaultLayer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export function init() {
    return runPromise((s) => s.init())
  }

  export function load() {
    return runPromise((s) => s.load())
  }

  export function getSnapshot() {
    return runPromise((s) => s.getSnapshot())
  }

  export function add(target: "memory" | "user", content: string) {
    return runPromise((s) => s.add(target, content))
  }

  export function replace(target: "memory" | "user", oldText: string, content: string) {
    return runPromise((s) => s.replace(target, oldText, content))
  }

  export function remove(target: "memory" | "user", oldText: string) {
    return runPromise((s) => s.remove(target, oldText))
  }

  export function clear(target: "memory" | "user") {
    return runPromise((s) => s.clear(target))
  }

  export function reload() {
    return runPromise((s) => s.reload())
  }

  export function incrementTurn(sessionID: SessionID) {
    return runPromise((s) => s.incrementTurn(sessionID))
  }

  export function checkNudge(sessionID: SessionID) {
    return runPromise((s) => s.checkNudge(sessionID))
  }

  export function incrementSkillTurns(sessionID: SessionID) {
    return runPromise((s) => s.incrementSkillTurns(sessionID))
  }

  export function checkSkillNudge(sessionID: SessionID) {
    return runPromise((s) => s.checkSkillNudge(sessionID))
  }
}
