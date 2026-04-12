import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../project/instance"
import { getWorkingDirectory } from "@/util/working-directory"

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
  const workingDir = getWorkingDirectory()
  return Instance.provide({
    directory: workingDir,
    init: InstanceBootstrap,
    fn: async () => {
      try {
        const result = await cb()
        return result
      } finally {
        await Instance.dispose()
      }
    },
  })
}
