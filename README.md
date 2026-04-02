# handofai

**Command:** `handofaicli`
**Internal Brand:** `handofai`
**Base:** [OpenCode](https://opencode.ai) — the open source AI coding agent
**Inspiration:** [Hermes Agent](https://github.com/nousresearch/hermes-agent) — self-improving AI agent with memory, skills, tools, and multi-platform support

---

## What Is handofai?

handofai transforms OpenCode into a Hermes-like self-improving AI agent while preserving all core OpenCode infrastructure — 88 providers, TUI, plugin system, MCP, and server mode. Everything is written in TypeScript.

---

## What We Keep from OpenCode

| Feature | Status |
|---------|--------|
| Provider/model management (88 providers, Vercel AI SDK) | Inherited |
| TUI framework (SolidJS + @opentui/core) | Inherited |
| Session/agent system with primary agents and subagents | Inherited |
| Plugin system with hooks | Inherited |
| MCP integration | Inherited |
| Server mode (HTTP API) | Inherited |
| Config system | Inherited |
| SQLite database (WAL mode) | Inherited |
| Context compaction | Inherited |
| Tool output pruning | Inherited |
| Instruction files (AGENTS.md, CLAUDE.md) | Inherited |

---

## What's Been Implemented

### Phase 0: Repository Setup ✅

- Branding updated to handofai across CLI, TUI, and config paths
- `handofaicli` command works with handofai branding
- Build pipeline verified

### Phase 1: Memory System ✅

Two-layer memory architecture inspired by Hermes:

**Local File-Based Memory:**
- `MEMORY.md` — Agent notes (2,200 char limit)
- `USER.md` — User profile and preferences (1,375 char limit)
- Frozen snapshot pattern — memory loaded once at session start, stays stable during conversation
- Content security scanning — blocks prompt injection, exfiltration patterns, invisible Unicode
- Tool: `memory` (add/replace/remove entries)

**Cross-Session Search:**
- Full-text searchable conversation history across all past sessions
- Tool: `session_search` — query past conversations by keyword, filter by role
- Recent sessions listing when no query provided

**Nudge System:**
- Background review agent that runs after sessions complete
- Automatically extracts and saves user preferences, expectations, and personal details

### Phase 2: Enhanced Tools ✅

#### Multi-Backend Terminal (`bash` tool)

Run commands across three execution environments:

| Backend | Description |
|---------|-------------|
| **local** | Direct host execution (default, zero behavior change) |
| **docker** | Hardened container with cap-drop ALL, no-new-privileges, pids-limit 256 |
| **ssh** | Remote execution via SSH with ControlMaster connection reuse |

Additional capabilities:

- **Background processes** — Long-running servers with session-based polling and watcher registration
- **PTY mode** — Interactive CLI tools (REPLs, vim, top) via optional `node-pty`
- **Dangerous command approval** — 32 built-in patterns (fork bomb, rm -rf /, curl|sh, etc.) with permanent allowlist saved to disk
- **Sudo handling** — Auto-inject password via `SUDO_PASSWORD` env var with failure tips
- **Output redaction** — ANSI stripping + 7 secret pattern detectors (API keys, tokens, private keys)
- **Environment passthrough** — Forward env vars into Docker containers via `docker_forward_env` + `_HANDBACK_FORCE_` opt-in prefix
- **Persistent shell mode** — Long-lived bash shell across calls (variables, `cd` persist) via file-based IPC
- **Inactivity cleanup** — Auto-terminates idle backends after 300s, keeps sandboxes with active processes alive
- **Pre-flight requirements** — Validates Docker/SSH availability before tool is exposed to LLM

#### Read Loop Detection (`read` tool)

Prevents agents from getting stuck in read loops:

| Consecutive Reads | Behavior |
|-------------------|----------|
| 1st–2nd | No warning, content returned |
| 3rd | Warning appended (`<read_warning>`), content still returned |
| 4th+ | **BLOCKED** — returns error, no content |

Counter resets on: different file, different region (offset/limit), or any other tool call (bash, grep, edit, write, ls).

---

## What's Planned

| Phase | Feature | Description |
|-------|---------|-------------|
| 3 | Skills System | Self-improving skill ecosystem with discovery, installation, and auto-generation |
| 4 | Multi-Platform Gateway | Telegram, Discord, Slack, WhatsApp, Signal, Home Assistant adapters |
| 5 | Cron Scheduler | Automated recurring tasks and scheduled agent runs |
| 6 | Profile System | Multiple isolated instances with separate config, memory, and sessions |
| 7 | Enhanced CLI | Slash commands, theme/skin engine, interactive setup wizard |
| 8 | Browser Automation | Playwright integration with Browserbase and Camofox cloud backends |
| MVP+ | Additional Tools | Image generation (FAL.ai), text-to-speech, Home Assistant, execute-code sandbox |

---

## Building

```bash
cd packages/opencode
bun run build --single --skip-embed-web-ui
```

The built binary is placed in `dist/opencode-windows-x64/bin/opencode.exe` (or platform equivalent).

To update the global `handofaicli` command:

```bash
cp dist/opencode-windows-x64/bin/opencode.exe ~/.bun/bin/handofaicli.exe
```

---

## Configuration

Add to your `opencode.json` or `.opencode/config.json`:

```json
{
  "bash": {
    "backend": "local",
    "docker_image": "nikolaik/python-nodejs:python3.11-nodejs20",
    "docker_forward_env": ["MY_API_KEY"],
    "local_persistent": false,
    "ssh_host": "",
    "ssh_user": "",
    "ssh_port": 22,
    "lifetime_seconds": 300,
    "approval_mode": "manual"
  }
}
```

---

## Upstream

This project is a fork of [OpenCode](https://github.com/anomalyco/opencode) — the open source AI coding agent. All upstream features are preserved; changes are additive only.

---

**Community** [OpenCode Discord](https://opencode.ai/discord) | [OpenCode Docs](https://opencode.ai/docs)
