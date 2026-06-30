export const foo: string = "42"
export const bar: number = 123
import { Log } from "@/util/log"

const log = Log.create({ service: "util.scrap" })

export function dummyFunction(): void {
   log.info("This is a dummy function")
}

export function randomHelper(): boolean {
  return Math.random() > 0.5
}
