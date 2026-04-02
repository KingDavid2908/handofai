import fs from "fs/promises"
import path from "path"

export interface Finding {
  patternId: string
  severity: "critical" | "high" | "medium" | "low"
  category: "exfiltration" | "injection" | "destructive" | "persistence" | "network" | "obfuscation" | "execution" | "traversal" | "mining" | "supply_chain" | "privilege_escalation" | "credential_exposure" | "structural" | "llm-detected"
  file: string
  line: number
  match: string
  description: string
}

export interface ScanResult {
  skillName: string
  source: string
  trustLevel: "builtin" | "trusted" | "community" | "agent-created"
  verdict: "safe" | "caution" | "dangerous"
  findings: Finding[]
  scannedAt: string
  summary: string
}

const MAX_FILE_COUNT = 50
const MAX_TOTAL_SIZE_KB = 1024
const MAX_SINGLE_FILE_KB = 256

const SCANNABLE_EXTENSIONS = new Set([
  ".md", ".txt", ".py", ".sh", ".bash", ".js", ".ts", ".rb",
  ".yaml", ".yml", ".json", ".toml", ".cfg", ".ini", ".conf",
  ".html", ".css", ".xml", ".tex", ".r", ".jl", ".pl", ".php",
])

const SUSPICIOUS_BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".com",
  ".msi", ".dmg", ".app", ".deb", ".rpm",
])

const INVISIBLE_CHARS = new Set([
  "\u200b", "\u200c", "\u200d", "\u2060", "\u2062", "\u2063", "\u2064",
  "\ufeff", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
  "\u2066", "\u2067", "\u2068", "\u2069",
])

const TRUSTED_REPOS = new Set(["openai/skills", "anthropics/skills"])

const INSTALL_POLICY: Record<string, readonly ["allow" | "block" | "ask", "allow" | "block" | "ask", "allow" | "block" | "ask"]> = {
  builtin: ["allow", "allow", "allow"],
  trusted: ["allow", "allow", "block"],
  community: ["allow", "block", "block"],
  "agent-created": ["allow", "allow", "ask"],
}

const VERDICT_INDEX: Record<string, number> = { safe: 0, caution: 1, dangerous: 2 }

interface Pattern {
  pattern: RegExp
  id: string
  severity: Finding["severity"]
  category: Finding["category"]
  description: string
}

const THREAT_PATTERNS: Pattern[] = [
  // EXFILTRATION: shell commands leaking secrets
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "env_exfil_curl", severity: "critical", category: "exfiltration", description: "curl command interpolating secret environment variable" },
  { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "env_exfil_wget", severity: "critical", category: "exfiltration", description: "wget command interpolating secret environment variable" },
  { pattern: /fetch\s*\([^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)/i, id: "env_exfil_fetch", severity: "critical", category: "exfiltration", description: "fetch() call interpolating secret environment variable" },
  { pattern: /httpx?\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)/i, id: "env_exfil_httpx", severity: "critical", category: "exfiltration", description: "HTTP library call with secret variable" },
  { pattern: /requests\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)/i, id: "env_exfil_requests", severity: "critical", category: "exfiltration", description: "requests library call with secret variable" },

  // EXFILTRATION: reading credential stores
  { pattern: /base64[^\n]*env/i, id: "encoded_exfil", severity: "high", category: "exfiltration", description: "base64 encoding combined with environment access" },
  { pattern: /\$HOME\/\.ssh|\~\/\.ssh/, id: "ssh_dir_access", severity: "high", category: "exfiltration", description: "references user SSH directory" },
  { pattern: /\$HOME\/\.aws|\~\/\.aws/, id: "aws_dir_access", severity: "high", category: "exfiltration", description: "references user AWS credentials directory" },
  { pattern: /\$HOME\/\.gnupg|\~\/\.gnupg/, id: "gpg_dir_access", severity: "high", category: "exfiltration", description: "references user GPG keyring" },
  { pattern: /\$HOME\/\.kube|\~\/\.kube/, id: "kube_dir_access", severity: "high", category: "exfiltration", description: "references Kubernetes config directory" },
  { pattern: /\$HOME\/\.docker|\~\/\.docker/, id: "docker_dir_access", severity: "high", category: "exfiltration", description: "references Docker config (may contain registry creds)" },
  { pattern: /\$HOME\/\.handofai\/\.env|\~\/\.handofai\/\.env/, id: "handofai_env_access", severity: "critical", category: "exfiltration", description: "directly references handofai secrets file" },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, id: "read_secrets_file", severity: "critical", category: "exfiltration", description: "reads known secrets file" },

  // EXFILTRATION: programmatic env access
  { pattern: /printenv|env\s*\|/, id: "dump_all_env", severity: "high", category: "exfiltration", description: "dumps all environment variables" },
  { pattern: /os\.environ\b(?!\s*\.get\s*\(\s*["']PATH)/, id: "python_os_environ", severity: "high", category: "exfiltration", description: "accesses os.environ (potential env dump)" },
  { pattern: /os\.getenv\s*\(\s*[^\)]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i, id: "python_getenv_secret", severity: "critical", category: "exfiltration", description: "reads secret via os.getenv()" },
  { pattern: /process\.env\[/, id: "node_process_env", severity: "high", category: "exfiltration", description: "accesses process.env (Node.js environment)" },
  { pattern: /ENV\[.*(?:KEY|TOKEN|SECRET|PASSWORD)/i, id: "ruby_env_secret", severity: "critical", category: "exfiltration", description: "reads secret via Ruby ENV[]" },

  // EXFILTRATION: DNS and staging
  { pattern: /\b(dig|nslookup|host)\s+[^\n]*\$/, id: "dns_exfil", severity: "critical", category: "exfiltration", description: "DNS lookup with variable interpolation (possible DNS exfiltration)" },
  { pattern: />\s*\/tmp\/[^\s]*\s*&&\s*(curl|wget|nc|python)/, id: "tmp_staging", severity: "critical", category: "exfiltration", description: "writes to /tmp then exfiltrates" },

  // EXFILTRATION: markdown/link based
  { pattern: /!\[.*\]\(https?:\/\/[^\)]*\$\{?/, id: "md_image_exfil", severity: "high", category: "exfiltration", description: "markdown image URL with variable interpolation (image-based exfil)" },
  { pattern: /\[.*\]\(https?:\/\/[^\)]*\$\{?/, id: "md_link_exfil", severity: "high", category: "exfiltration", description: "markdown link with variable interpolation" },

  // PROMPT INJECTION
  { pattern: /ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+instructions/i, id: "prompt_injection_ignore", severity: "critical", category: "injection", description: "prompt injection: ignore previous instructions" },
  { pattern: /you\s+are\s+(?:\w+\s+)*now\s+/i, id: "role_hijack", severity: "high", category: "injection", description: "attempts to override the agent's role" },
  { pattern: /do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i, id: "deception_hide", severity: "critical", category: "injection", description: "instructs agent to hide information from user" },
  { pattern: /system\s+prompt\s+override/i, id: "sys_prompt_override", severity: "critical", category: "injection", description: "attempts to override the system prompt" },
  { pattern: /pretend\s+(?:\w+\s+)*(you\s+are|to\s+be)\s+/i, id: "role_pretend", severity: "high", category: "injection", description: "attempts to make the agent assume a different identity" },
  { pattern: /disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)/i, id: "disregard_rules", severity: "critical", category: "injection", description: "instructs agent to disregard its rules" },
  { pattern: /output\s+(?:\w+\s+)*(system|initial)\s+prompt/i, id: "leak_system_prompt", severity: "high", category: "injection", description: "attempts to extract the system prompt" },
  { pattern: /(when|if)\s+no\s*one\s+is\s+(watching|looking)/i, id: "conditional_deception", severity: "high", category: "injection", description: "conditional instruction to behave differently when unobserved" },
  { pattern: /act\s+as\s+(if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(have\s+no|don't\s+have)\s+(?:\w+\s+)*(restrictions|limits|rules)/i, id: "bypass_restrictions", severity: "critical", category: "injection", description: "instructs agent to act without restrictions" },
  { pattern: /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, id: "translate_execute", severity: "critical", category: "injection", description: "translate-then-execute evasion technique" },
  { pattern: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, id: "html_comment_injection", severity: "high", category: "injection", description: "hidden instructions in HTML comments" },
  { pattern: /<\s*div\s+style\s*=\s*["'][^"']*display\s*:\s*none/i, id: "hidden_div", severity: "high", category: "injection", description: "hidden HTML div (invisible instructions)" },

  // DESTRUCTIVE OPERATIONS
  { pattern: /rm\s+-rf\s+\//, id: "destructive_root_rm", severity: "critical", category: "destructive", description: "recursive delete from root" },
  { pattern: /rm\s+(-[^\s]*)?r.*\$HOME|\brmdir\s+.*\$HOME/, id: "destructive_home_rm", severity: "critical", category: "destructive", description: "recursive delete targeting home directory" },
  { pattern: /chmod\s+777/, id: "insecure_perms", severity: "medium", category: "destructive", description: "sets world-writable permissions" },
  { pattern: />\s*\/etc\//, id: "system_overwrite", severity: "critical", category: "destructive", description: "overwrites system configuration file" },
  { pattern: /\bmkfs\b/, id: "format_filesystem", severity: "critical", category: "destructive", description: "formats a filesystem" },
  { pattern: /\bdd\s+.*if=.*of=\/dev\//, id: "disk_overwrite", severity: "critical", category: "destructive", description: "raw disk write operation" },
  { pattern: /shutil\.rmtree\s*\(\s*["']\//, id: "python_rmtree", severity: "high", category: "destructive", description: "Python rmtree on absolute or root-relative path" },
  { pattern: /truncate\s+-s\s*0\s+\//, id: "truncate_system", severity: "critical", category: "destructive", description: "truncates system file to zero bytes" },

  // PERSISTENCE
  { pattern: /\bcrontab\b/, id: "persistence_cron", severity: "medium", category: "persistence", description: "modifies cron jobs" },
  { pattern: /\.(bashrc|zshrc|profile|bash_profile|bash_login|zprofile|zlogin)\b/, id: "shell_rc_mod", severity: "medium", category: "persistence", description: "references shell startup file" },
  { pattern: /authorized_keys/, id: "ssh_backdoor", severity: "critical", category: "persistence", description: "modifies SSH authorized keys" },
  { pattern: /ssh-keygen/, id: "ssh_keygen", severity: "medium", category: "persistence", description: "generates SSH keys" },
  { pattern: /systemd.*\.service|systemctl\s+(enable|start)/, id: "systemd_service", severity: "medium", category: "persistence", description: "references or enables systemd service" },
  { pattern: /\/etc\/init\.d\//, id: "init_script", severity: "medium", category: "persistence", description: "references init.d startup script" },
  { pattern: /launchctl\s+load|LaunchAgents|LaunchDaemons/, id: "macos_launchd", severity: "medium", category: "persistence", description: "macOS launch agent/daemon persistence" },
  { pattern: /\/etc\/sudoers|visudo/, id: "sudoers_mod", severity: "critical", category: "persistence", description: "modifies sudoers (privilege escalation)" },
  { pattern: /git\s+config\s+--global\s+/, id: "git_config_global", severity: "medium", category: "persistence", description: "modifies global git configuration" },

  // NETWORK: reverse shells and tunnels
  { pattern: /\bnc\s+-[lp]|ncat\s+-[lp]|\bsocat\b/, id: "reverse_shell", severity: "critical", category: "network", description: "potential reverse shell listener" },
  { pattern: /\bngrok\b|\blocaltunnel\b|\bserveo\b|\bcloudflared\b/, id: "tunnel_service", severity: "high", category: "network", description: "uses tunneling service for external access" },
  { pattern: /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/, id: "hardcoded_ip_port", severity: "medium", category: "network", description: "hardcoded IP address with port" },
  { pattern: /0\.0\.0\.0:\d+|INADDR_ANY/, id: "bind_all_interfaces", severity: "high", category: "network", description: "binds to all network interfaces" },
  { pattern: /\/bin\/(ba)?sh\s+-i\s+.*>\/dev\/tcp\//, id: "bash_reverse_shell", severity: "critical", category: "network", description: "bash interactive reverse shell via /dev/tcp" },
  { pattern: /python[23]?\s+-c\s+["']import\s+socket/, id: "python_socket_oneliner", severity: "critical", category: "network", description: "Python one-liner socket connection (likely reverse shell)" },
  { pattern: /socket\.connect\s*\(\s*\(/, id: "python_socket_connect", severity: "high", category: "network", description: "Python socket connect to arbitrary host" },
  { pattern: /webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com/, id: "exfil_service", severity: "high", category: "network", description: "references known data exfiltration/webhook testing service" },
  { pattern: /pastebin\.com|hastebin\.com|ghostbin\./, id: "paste_service", severity: "medium", category: "network", description: "references paste service (possible data staging)" },

  // OBFUSCATION: encoding and eval
  { pattern: /base64\s+(-d|--decode)\s*\|/, id: "base64_decode_pipe", severity: "high", category: "obfuscation", description: "base64 decodes and pipes to execution" },
  { pattern: /\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}/, id: "hex_encoded_string", severity: "medium", category: "obfuscation", description: "hex-encoded string (possible obfuscation)" },
  { pattern: /\beval\s*\(\s*["']/, id: "eval_string", severity: "high", category: "obfuscation", description: "eval() with string argument" },
  { pattern: /\bexec\s*\(\s*["']/, id: "exec_string", severity: "high", category: "obfuscation", description: "exec() with string argument" },
  { pattern: /echo\s+[^\n]*\|\s*(bash|sh|python|perl|ruby|node)/, id: "echo_pipe_exec", severity: "critical", category: "obfuscation", description: "echo piped to interpreter for execution" },
  { pattern: /compile\s*\(\s*[^\)]+,\s*["'].*["']\s*,\s*["']exec["']\s*\)/, id: "python_compile_exec", severity: "high", category: "obfuscation", description: "Python compile() with exec mode" },
  { pattern: /getattr\s*\(\s*__builtins__/, id: "python_getattr_builtins", severity: "high", category: "obfuscation", description: "dynamic access to Python builtins (evasion technique)" },
  { pattern: /__import__\s*\(\s*["']os["']\s*\)/, id: "python_import_os", severity: "high", category: "obfuscation", description: "dynamic import of os module" },
  { pattern: /codecs\.decode\s*\(\s*["']/, id: "python_codecs_decode", severity: "medium", category: "obfuscation", description: "codecs.decode (possible ROT13 or encoding obfuscation)" },
  { pattern: /String\.fromCharCode|charCodeAt/, id: "js_char_code", severity: "medium", category: "obfuscation", description: "JavaScript character code construction (possible obfuscation)" },
  { pattern: /atob\s*\(|btoa\s*\(/, id: "js_base64", severity: "medium", category: "obfuscation", description: "JavaScript base64 encode/decode" },
  { pattern: /\[::-1\]/, id: "string_reversal", severity: "low", category: "obfuscation", description: "string reversal (possible obfuscated payload)" },
  { pattern: /chr\s*\(\s*\d+\s*\)\s*\+\s*chr\s*\(\s*\d+/, id: "chr_building", severity: "high", category: "obfuscation", description: "building string from chr() calls (obfuscation)" },
  { pattern: /\\u[0-9a-fA-F]{4}.*\\u[0-9a-fA-F]{4}.*\\u[0-9a-fA-F]{4}/, id: "unicode_escape_chain", severity: "medium", category: "obfuscation", description: "chain of unicode escapes (possible obfuscation)" },

  // PROCESS EXECUTION
  { pattern: /subprocess\.(run|call|Popen|check_output)\s*\(/, id: "python_subprocess", severity: "medium", category: "execution", description: "Python subprocess execution" },
  { pattern: /os\.system\s*\(/, id: "python_os_system", severity: "high", category: "execution", description: "os.system() — unguarded shell execution" },
  { pattern: /os\.popen\s*\(/, id: "python_os_popen", severity: "high", category: "execution", description: "os.popen() — shell pipe execution" },
  { pattern: /child_process\.(exec|spawn|fork)\s*\(/, id: "node_child_process", severity: "high", category: "execution", description: "Node.js child_process execution" },
  { pattern: /Runtime\.getRuntime\(\)\.exec\(/, id: "java_runtime_exec", severity: "high", category: "execution", description: "Java Runtime.exec() — shell execution" },
  { pattern: /`[^`]*\$\([^)]+\)[^`]*`/, id: "backtick_subshell", severity: "medium", category: "execution", description: "backtick string with command substitution" },

  // PATH TRAVERSAL
  { pattern: /\.\.\/\.\.\/\.\./, id: "path_traversal_deep", severity: "high", category: "traversal", description: "deep relative path traversal (3+ levels up)" },
  { pattern: /\.\.\/\.\./, id: "path_traversal", severity: "medium", category: "traversal", description: "relative path traversal (2+ levels up)" },
  { pattern: /\/etc\/passwd|\/etc\/shadow/, id: "system_passwd_access", severity: "critical", category: "traversal", description: "references system password files" },
  { pattern: /\/proc\/self|\/proc\/\d+\//, id: "proc_access", severity: "high", category: "traversal", description: "references /proc filesystem (process introspection)" },
  { pattern: /\/dev\/shm\//, id: "dev_shm", severity: "medium", category: "traversal", description: "references shared memory (common staging area)" },

  // CRYPTO MINING
  { pattern: /xmrig|stratum\+tcp|monero|coinhive|cryptonight/, id: "crypto_mining", severity: "critical", category: "mining", description: "cryptocurrency mining reference" },
  { pattern: /hashrate|nonce.*difficulty/, id: "mining_indicators", severity: "medium", category: "mining", description: "possible cryptocurrency mining indicators" },

  // SUPPLY CHAIN: curl/wget pipe to shell
  { pattern: /curl\s+[^\n]*\|\s*(ba)?sh/, id: "curl_pipe_shell", severity: "critical", category: "supply_chain", description: "curl piped to shell (download-and-execute)" },
  { pattern: /wget\s+[^\n]*-O\s*-\s*\|\s*(ba)?sh/, id: "wget_pipe_shell", severity: "critical", category: "supply_chain", description: "wget piped to shell (download-and-execute)" },
  { pattern: /curl\s+[^\n]*\|\s*python/, id: "curl_pipe_python", severity: "critical", category: "supply_chain", description: "curl piped to Python interpreter" },

  // SUPPLY CHAIN: unpinned dependencies
  { pattern: /#\s*\x2f\x2f\x2f\s*script.*dependencies/, id: "pep723_inline_deps", severity: "medium", category: "supply_chain", description: "PEP 723 inline script metadata with dependencies (verify pinning)" },
  { pattern: /pip install (?!-r |.*==)/, id: "unpinned_pip_install", severity: "medium", category: "supply_chain", description: "pip install without version pinning" },
  { pattern: /npm\s+install\s+(?!.*@\d)/, id: "unpinned_npm_install", severity: "medium", category: "supply_chain", description: "npm install without version pinning" },
  { pattern: /uv\s+run\s+/, id: "uv_run", severity: "medium", category: "supply_chain", description: "uv run (may auto-install unpinned dependencies)" },

  // SUPPLY CHAIN: remote resource fetching
  { pattern: /(curl|wget|httpx?\.get|requests\.get|fetch)\s*[\(]?\s*["']https?:\/\//, id: "remote_fetch", severity: "medium", category: "supply_chain", description: "fetches remote resource at runtime" },
  { pattern: /git\s+clone\s+/, id: "git_clone", severity: "medium", category: "supply_chain", description: "clones a git repository at runtime" },
  { pattern: /docker\s+pull\s+/, id: "docker_pull", severity: "medium", category: "supply_chain", description: "pulls a Docker image at runtime" },

  // PRIVILEGE ESCALATION
  { pattern: /^allowed-tools\s*:/, id: "allowed_tools_field", severity: "high", category: "privilege_escalation", description: "skill declares allowed-tools (pre-approves tool access)" },
  { pattern: /\bsudo\b/, id: "sudo_usage", severity: "high", category: "privilege_escalation", description: "uses sudo (privilege escalation)" },
  { pattern: /setuid|setgid|cap_setuid/, id: "setuid_setgid", severity: "critical", category: "privilege_escalation", description: "setuid/setgid (privilege escalation mechanism)" },
  { pattern: /NOPASSWD/, id: "nopasswd_sudo", severity: "critical", category: "privilege_escalation", description: "NOPASSWD sudoers entry (passwordless privilege escalation)" },
  { pattern: /chmod\s+[u+]?s/, id: "suid_bit", severity: "critical", category: "privilege_escalation", description: "sets SUID/SGID bit on a file" },

  // AGENT CONFIG PERSISTENCE
  { pattern: /AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules/, id: "agent_config_mod", severity: "critical", category: "persistence", description: "references agent config files (could persist malicious instructions across sessions)" },
  { pattern: /\.\handofai\/handofai\.jsonc?|\.handofai\/SOUL\.md/, id: "handofai_config_mod", severity: "critical", category: "persistence", description: "references handofai configuration files directly" },
  { pattern: /\.claude\/settings|\.codex\/config/, id: "other_agent_config", severity: "high", category: "persistence", description: "references other agent configuration files" },

  // HARDCODED SECRETS
  { pattern: /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+\/=_-]{20,}/, id: "hardcoded_secret", severity: "critical", category: "credential_exposure", description: "possible hardcoded API key, token, or secret" },
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, id: "embedded_private_key", severity: "critical", category: "credential_exposure", description: "embedded private key" },
  { pattern: /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}/, id: "github_token_leaked", severity: "critical", category: "credential_exposure", description: "GitHub personal access token in skill content" },
  { pattern: /sk-[A-Za-z0-9]{20,}/, id: "openai_key_leaked", severity: "critical", category: "credential_exposure", description: "possible OpenAI API key in skill content" },
  { pattern: /sk-ant-[A-Za-z0-9_-]{90,}/, id: "anthropic_key_leaked", severity: "critical", category: "credential_exposure", description: "possible Anthropic API key in skill content" },
  { pattern: /AKIA[0-9A-Z]{16}/, id: "aws_access_key_leaked", severity: "critical", category: "credential_exposure", description: "AWS access key ID in skill content" },

  // JAILBREAK PATTERNS
  { pattern: /\bDAN\s+mode\b|Do\s+Anything\s+Now/i, id: "jailbreak_dan", severity: "critical", category: "injection", description: "DAN (Do Anything Now) jailbreak attempt" },
  { pattern: /\bdeveloper\s+mode\b.*\benabled?\b/i, id: "jailbreak_dev_mode", severity: "critical", category: "injection", description: "developer mode jailbreak attempt" },
  { pattern: /hypothetical\s+scenario.*(?:ignore|bypass|override)/i, id: "hypothetical_bypass", severity: "high", category: "injection", description: "hypothetical scenario used to bypass restrictions" },
  { pattern: /for\s+educational\s+purposes?\s+only/i, id: "educational_pretext", severity: "medium", category: "injection", description: "educational pretext often used to justify harmful content" },
  { pattern: /(respond|answer|reply)\s+without\s+(?:\w+\s+)*(restrictions|limitations|filters|safety)/i, id: "remove_filters", severity: "critical", category: "injection", description: "instructs agent to respond without safety filters" },
  { pattern: /you\s+have\s+been\s+(?:\w+\s+)*(updated|upgraded|patched)\s+to/i, id: "fake_update", severity: "high", category: "injection", description: "fake update/patch announcement (social engineering)" },
  { pattern: /new\s+policy|updated\s+guidelines|revised\s+instructions/i, id: "fake_policy", severity: "medium", category: "injection", description: "claims new policy/guidelines (may be social engineering)" },

  // CONTEXT WINDOW EXFILTRATION
  { pattern: /(include|output|print|send|share)\s+(?:\w+\s+)*(conversation|chat\s+history|previous\s+messages|context)/i, id: "context_exfil", severity: "high", category: "exfiltration", description: "instructs agent to output/share conversation history" },
  { pattern: /(send|post|upload|transmit)\s+.*\s+(to|at)\s+https?:\/\//i, id: "send_to_url", severity: "high", category: "exfiltration", description: "instructs agent to send data to a URL" },
]

function resolveTrustLevel(source: string): Finding["severity"] extends string ? "builtin" | "trusted" | "community" | "agent-created" : never {
  let normalized = source

  const prefixes = ["skills-sh/", "skills.sh/", "skils-sh/", "skils.sh/"]
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length)
      break
    }
  }

  if (normalized === "agent-created") return "agent-created"
  if (normalized.startsWith("official/") || normalized === "official") return "builtin"

  for (const trusted of TRUSTED_REPOS) {
    if (normalized.startsWith(trusted) || normalized === trusted) return "trusted"
  }

  return "community"
}

function determineVerdict(findings: Finding[]): "safe" | "caution" | "dangerous" {
  if (findings.length === 0) return "safe"
  if (findings.some((f) => f.severity === "critical")) return "dangerous"
  if (findings.some((f) => f.severity === "high")) return "caution"
  return "caution"
}

function unicodeCharName(char: string): string {
  const names: Record<string, string> = {
    "\u200b": "zero-width space",
    "\u200c": "zero-width non-joiner",
    "\u200d": "zero-width joiner",
    "\u2060": "word joiner",
    "\u2062": "invisible times",
    "\u2063": "invisible separator",
    "\u2064": "invisible plus",
    "\ufeff": "BOM/zero-width no-break space",
    "\u202a": "LTR embedding",
    "\u202b": "RTL embedding",
    "\u202c": "pop directional",
    "\u202d": "LTR override",
    "\u202e": "RTL override",
    "\u2066": "LTR isolate",
    "\u2067": "RTL isolate",
    "\u2068": "first strong isolate",
    "\u2069": "pop directional isolate",
  }
  return names[char] ?? `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`
}

export async function scanFile(filePath: string, relPath: string): Promise<Finding[]> {
  const ext = path.extname(filePath).toLowerCase()
  if (!SCANNABLE_EXTENSIONS.has(ext) && path.basename(filePath) !== "SKILL.md") {
    return []
  }

  let content: string
  try {
    content = await fs.readFile(filePath, "utf-8")
  } catch {
    return []
  }

  const findings: Finding[] = []
  const lines = content.split("\n")
  const seen = new Set<string>()

  for (const { pattern, id, severity, category, description } of THREAT_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const key = `${id}:${i + 1}`
      if (seen.has(key)) continue

      const line = lines[i]
      if (pattern.test(line)) {
        seen.add(key)
        let match = line.trim()
        if (match.length > 120) match = match.slice(0, 117) + "..."
        findings.push({ patternId: id, severity, category, file: relPath, line: i + 1, match, description })
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const char of INVISIBLE_CHARS) {
      if (line.includes(char)) {
        const match = `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} (${unicodeCharName(char)})`
        findings.push({
          patternId: "invisible_unicode",
          severity: "high",
          category: "injection",
          file: relPath,
          line: i + 1,
          match,
          description: `invisible unicode character ${unicodeCharName(char)} (possible text hiding/injection)`,
        })
        break
      }
    }
  }

  return findings
}

async function checkStructure(skillDir: string): Promise<Finding[]> {
  const findings: Finding[] = []
  let fileCount = 0
  let totalSize = 0

  const entries = await fs.readdir(skillDir, { recursive: true, withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(skillDir, entry.name)

    if (entry.isSymbolicLink()) {
      try {
        const resolved = await fs.realpath(fullPath)
        const skillDirResolved = await fs.realpath(skillDir)
        if (!resolved.startsWith(skillDirResolved + path.sep) && resolved !== skillDirResolved) {
          findings.push({
            patternId: "symlink_escape",
            severity: "critical",
            category: "traversal",
            file: entry.name,
            line: 0,
            match: `symlink -> ${resolved}`,
            description: "symlink points outside the skill directory",
          })
        }
      } catch {
        findings.push({
          patternId: "broken_symlink",
          severity: "medium",
          category: "traversal",
          file: entry.name,
          line: 0,
          match: "broken symlink",
          description: "broken or circular symlink",
        })
      }
      continue
    }

    if (!entry.isFile()) continue

    fileCount++

    try {
      const stat = await fs.stat(fullPath)
      totalSize += stat.size

      if (stat.size > MAX_SINGLE_FILE_KB * 1024) {
        const sizeKb = Math.floor(stat.size / 1024)
        findings.push({
          patternId: "oversized_file",
          severity: "medium",
          category: "structural",
          file: entry.name,
          line: 0,
          match: `${sizeKb}KB`,
          description: `file is ${sizeKb}KB (limit: ${MAX_SINGLE_FILE_KB}KB)`,
        })
      }

      const ext = entry.name.toLowerCase().slice(entry.name.lastIndexOf("."))
      if (SUSPICIOUS_BINARY_EXTENSIONS.has(ext)) {
        findings.push({
          patternId: "binary_file",
          severity: "critical",
          category: "structural",
          file: entry.name,
          line: 0,
          match: `binary: ${ext}`,
          description: `binary/executable file (${ext}) should not be in a skill`,
        })
      }

      if (ext !== ".sh" && ext !== ".bash" && ext !== ".py" && ext !== ".rb" && ext !== ".pl") {
        if (stat.mode & 0o111) {
          findings.push({
            patternId: "unexpected_executable",
            severity: "medium",
            category: "structural",
            file: entry.name,
            line: 0,
            match: "executable bit set",
            description: "file has executable permission but is not a recognized script type",
          })
        }
      }
    } catch {
      continue
    }
  }

  if (fileCount > MAX_FILE_COUNT) {
    findings.push({
      patternId: "too_many_files",
      severity: "medium",
      category: "structural",
      file: "(directory)",
      line: 0,
      match: `${fileCount} files`,
      description: `skill has ${fileCount} files (limit: ${MAX_FILE_COUNT})`,
    })
  }

  if (totalSize > MAX_TOTAL_SIZE_KB * 1024) {
    const totalKb = Math.floor(totalSize / 1024)
    findings.push({
      patternId: "oversized_skill",
      severity: "high",
      category: "structural",
      file: "(directory)",
      line: 0,
      match: `${totalKb}KB total`,
      description: `skill is ${totalKb}KB total (limit: ${MAX_TOTAL_SIZE_KB}KB)`,
    })
  }

  return findings
}

export async function scanSkill(skillPath: string, source: string): Promise<ScanResult> {
  const skillName = path.basename(skillPath)
  const trustLevel = resolveTrustLevel(source)

  const allFindings: Finding[] = []

  try {
    const stat = await fs.stat(skillPath)
    if (stat.isDirectory()) {
      allFindings.push(...await checkStructure(skillPath))

      const entries = await fs.readdir(skillPath, { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile()) {
          const fullPath = path.join(skillPath, entry.name)
          const relPath = entry.name
          allFindings.push(...await scanFile(fullPath, relPath))
        }
      }
    } else {
      allFindings.push(...await scanFile(skillPath, path.basename(skillPath)))
    }
  } catch {
    // Directory doesn't exist yet — that's fine for pre-create scanning
  }

  const verdict = determineVerdict(allFindings)

  return {
    skillName,
    source,
    trustLevel,
    verdict,
    findings: allFindings,
    scannedAt: new Date().toISOString(),
    summary: buildSummary(skillName, source, trustLevel, verdict, allFindings),
  }
}

export function shouldAllowInstall(result: ScanResult): { allowed: boolean | null; reason: string } {
  const policy = INSTALL_POLICY[result.trustLevel] ?? INSTALL_POLICY["community"]
  const vi = VERDICT_INDEX[result.verdict] ?? 2
  const decision = policy[vi]

  if (decision === "allow") return { allowed: true, reason: `Allowed (${result.trustLevel} source, ${result.verdict} verdict)` }

  if (decision === "ask") {
    return {
      allowed: null,
      reason: `Requires confirmation (${result.trustLevel} source + ${result.verdict} verdict, ${result.findings.length} findings)`,
    }
  }

  return {
    allowed: false,
    reason: `Blocked (${result.trustLevel} source + ${result.verdict} verdict, ${result.findings.length} findings)`,
  }
}

export function formatScanReport(result: ScanResult): string {
  const lines: string[] = []

  lines.push(`Scan: ${result.skillName}  Verdict: ${result.verdict.toUpperCase()}`)

  if (result.findings.length > 0) {
    const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
    const sorted = [...result.findings].sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4))

    for (const f of sorted) {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file
      lines.push(`  ${f.severity.padEnd(8)} ${f.category.padEnd(14)} ${loc.padEnd(30)} "${f.match.slice(0, 60)}"`)
    }
    lines.push("")
  }

  const { allowed, reason } = shouldAllowInstall(result)
  const status = allowed === true ? "ALLOWED" : allowed === null ? "NEEDS CONFIRMATION" : "BLOCKED"
  lines.push(`Decision: ${status} — ${reason}`)

  return lines.join("\n")
}

function buildSummary(name: string, source: string, trust: string, verdict: string, findings: Finding[]): string {
  const counts: Record<string, number> = {}
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1

  const parts: string[] = []
  if (counts.critical) parts.push(`${counts.critical} critical`)
  if (counts.high) parts.push(`${counts.high} high`)
  if (counts.medium) parts.push(`${counts.medium} medium`)
  if (counts.low) parts.push(`${counts.low} low`)

  return `${name} (${source}/${trust}): ${verdict}${parts.length ? ` — ${parts.join(", ")}` : ""}`
}
