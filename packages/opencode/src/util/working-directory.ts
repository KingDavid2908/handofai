export function getWorkingDirectory(): string {
  return process.env.OPENCODE_CWD || process.cwd()
}
