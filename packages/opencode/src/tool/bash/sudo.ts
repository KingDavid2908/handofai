import { Log } from "@/util/log"

const log = Log.create({ service: "sudo" })
let _cachedSudoPassword = ""

export interface SudoResult {
  transformedCommand: string
  sudoStdin: string | null
}

export type SudoPromptFn = () => Promise<string | null>

export async function transformSudo(
  command: string,
  env: Record<string, string>,
  promptFn?: SudoPromptFn,
): Promise<SudoResult> {
  if (!/\bsudo\b/.test(command)) {
    return { transformedCommand: command, sudoStdin: null }
  }

  let password: string | null = env.SUDO_PASSWORD || _cachedSudoPassword || null

  if (!password && promptFn) {
    try {
      password = await promptFn()
    } catch {
      password = null
    }
  }

  if (!password) return { transformedCommand: command, sudoStdin: null }

  _cachedSudoPassword = password
  const transformed = command.replace(/\bsudo\b/g, "sudo -S -p ''")
  return { transformedCommand: transformed, sudoStdin: password + "\n" }
}

export function handleSudoFailure(output: string, isGateway: boolean): string {
  if (!isGateway) return output
  const lower = output.toLowerCase()
  if (
    lower.includes("a password is required") ||
    lower.includes("no tty present") ||
    lower.includes("a terminal is required")
  ) {
    return output + "\n\nTip: To enable sudo, add SUDO_PASSWORD to your handofai config (.env file)."
  }
  return output
}

export function clearSudoCache(): void {
  _cachedSudoPassword = ""
}
