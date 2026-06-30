import { z } from "zod"
import { Log } from "@/util/log"

const log = Log.create({ service: "util.fn" })

export function fn<T extends z.ZodType, Result>(schema: T, cb: (input: z.infer<T>) => Result) {
  const result = (input: z.infer<T>) => {
    let parsed
    try {
      parsed = schema.parse(input)
    } catch (e) {
      log.debug("schema validation failure stack trace:")
      if (e instanceof z.ZodError) {
        log.error(`schema validation issues: ${JSON.stringify(e.issues, null, 2)}`)
      }
      throw e
    }

    return cb(parsed)
  }
  result.force = (input: z.infer<T>) => cb(input)
  result.schema = schema
  return result
 }
