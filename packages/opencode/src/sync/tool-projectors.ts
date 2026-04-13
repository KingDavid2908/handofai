import { SyncEvent } from "@/sync"
import { Log } from "@/util/log"

const log = Log.create({ service: "tool-projector" })

export default [
  SyncEvent.project(SyncEvent.ToolEvent.SkillInstalled, (db, data) => {
    log.info("skill installed", { name: data.name, location: data.location })
    // TODO: Invalidate skill cache
  }),

  SyncEvent.project(SyncEvent.ToolEvent.SkillRemoved, (db, data) => {
    log.info("skill removed", { name: data.name })
  }),

  SyncEvent.project(SyncEvent.ToolEvent.ConnectorAdded, (db, data) => {
    log.info("connector added", { name: data.name, baseUrl: data.baseUrl })
  }),

  SyncEvent.project(SyncEvent.ToolEvent.ConnectorRemoved, (db, data) => {
    log.info("connector removed", { name: data.name })
  }),

  SyncEvent.project(SyncEvent.ToolEvent.PluginInstalled, (db, data) => {
    log.info("plugin installed", { name: data.name, source: data.source })
  }),

  SyncEvent.project(SyncEvent.ToolEvent.PluginRemoved, (db, data) => {
    log.info("plugin removed", { name: data.name })
  }),
]
