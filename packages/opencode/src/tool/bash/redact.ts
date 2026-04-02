const ANSI_OSC_REGEX = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g
const ANSI_CSI_REGEX = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g

const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /(sk-[a-zA-Z0-9]{20,})/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /(ghp_[a-zA-Z0-9]{36})/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /(xox[baprs]-[a-zA-Z0-9-]+)/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  { pattern: /(AKIA[0-9A-Z]{16})/g, replacement: "[REDACTED_AWS_KEY]" },
  { pattern: /(eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/g, replacement: "[REDACTED_JWT]" },
  { pattern: /(-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----)/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  { pattern: /((?:PASSWORD|SECRET|TOKEN|API_KEY|APIKEY|AUTH_TOKEN)\s*[=:]\s*)\S+/gi, replacement: "$1[REDACTED]" },
]

export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_OSC_REGEX, "")
    .replace(ANSI_CSI_REGEX, "")
    .replace(ANSI_REGEX, "")
    .replace(/\x1b/g, "")
    .replace(/\x07/g, "")
    .replace(/\x1b\\/, "")
}

export function redactSecrets(text: string): string {
  let result = text
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

export function postProcess(text: string): { output: string; redacted: boolean } {
  const stripped = stripAnsi(text)
  const redacted = redactSecrets(stripped)
  return { output: redacted, redacted: redacted !== stripped }
}
