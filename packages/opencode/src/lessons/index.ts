import { Effect, Layer, ServiceMap } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { LessonStore } from "./lesson-store"
import { Config } from "@/config/config"
import { Log } from "@/util/log"

export namespace LessonService {
  const log = Log.create({ service: "lesson.service" })

  export interface Snapshot {
    lessons: string
    usage: { used: number; limit: number; percent: number }
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly load: () => Effect.Effect<void>
    readonly getSnapshot: () => Effect.Effect<Snapshot | null>
    readonly add: (content: string) => Effect.Effect<{ success: boolean; error?: string }>
    readonly replace: (oldText: string, content: string) => Effect.Effect<{ success: boolean; error?: string }>
    readonly remove: (oldText: string) => Effect.Effect<{ success: boolean; error?: string }>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/LessonService") {}

  export const layer: Layer.Layer<Service, never, Config.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service

      const init = Effect.fn("LessonService.init")(function* () {
        const cfg = yield* config.get()
        const lessonsConfig = cfg.lessons
        if (lessonsConfig && "enabled" in lessonsConfig && lessonsConfig.enabled === false) return
        yield* Effect.promise(() => LessonStore.init())
      })

      const load = Effect.fn("LessonService.load")(function* () {
        yield* Effect.promise(() => LessonStore.load())
      })

      const getSnapshot = Effect.fn("LessonService.getSnapshot")(function* () {
        if (!LessonStore.isInitialized()) return null
        const snapshot = LessonStore.getSnapshot()
        if (!snapshot) return null
        return {
          lessons: snapshot.lessons,
          usage: snapshot.usage,
        }
      })

      const add = Effect.fn("LessonService.add")(function* (content: string) {
        const result = yield* Effect.promise(() => LessonStore.add(content))
        return { success: result.success, error: result.error }
      })

      const replace = Effect.fn("LessonService.replace")(function* (oldText: string, content: string) {
        const result = yield* Effect.promise(() => LessonStore.replace(oldText, content))
        return { success: result.success, error: result.error }
      })

      const remove = Effect.fn("LessonService.remove")(function* (oldText: string) {
        const result = yield* Effect.promise(() => LessonStore.remove(oldText))
        return { success: result.success, error: result.error }
      })

      return Service.of({
        init,
        load,
        getSnapshot,
        add,
        replace,
        remove,
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

  export function add(content: string) {
    return runPromise((s) => s.add(content))
  }

  export function replace(oldText: string, content: string) {
    return runPromise((s) => s.replace(oldText, content))
  }

  export function remove(oldText: string) {
    return runPromise((s) => s.remove(oldText))
  }
}
