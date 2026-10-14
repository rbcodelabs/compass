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

import { realpathSync } from "node:fs"
import path from "node:path"

export type GuardDecision = { allowed: true } | { allowed: false; reason: string }

/** Tool-input fields that carry a filesystem path, whatever the tool is called. */
const PATH_FIELDS = ["file_path", "path", "notebook_path"]
/** Tools that MUST name a file; a missing path is a deny, not a default to cwd. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"])
const GLOB_TOOLS = new Set(["Glob", "Grep"])

/**
 * The real location of `target`, with every symlink on its existing prefix
 * resolved. A path that does not exist yet (Write creating a new file) resolves
 * its deepest existing ancestor and re-appends the rest, so a symlinked directory
 * cannot smuggle a not-yet-created file outside the root.
 */
function resolveReal(target: string): string {
  let current = target
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch {
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

function checkPath(value: unknown, field: string, realRoot: string): string | null {
  if (typeof value !== "string" || value.length === 0) return `${field} must be a non-empty string`
  if (value.includes("\0")) return `${field} contains a NUL byte`
  // Relative paths are relative to the docs root (the agent's cwd).
  const real = resolveReal(path.resolve(realRoot, value))
  return insideRoot(realRoot, real) ? null : `${field} is outside the docs directory`
}

/** Glob/Grep patterns can carry an absolute or parent-relative anchor of their own, including inside braces. */
function checkPattern(value: unknown): string | null {
  if (typeof value !== "string") return "pattern must be a string"
  if (value.includes("\0")) return "pattern contains a NUL byte"
  if (value.includes("..")) return "pattern may not contain .."
  if (/(^|[{,])\s*[/~]/.test(value) || /^[A-Za-z]:/.test(value)) return "pattern must be relative to the docs directory"
  return null
}

export function checkDocsToolUse(toolName: string, toolInput: unknown, docsRoot: string): GuardDecision {
  let realRoot: string
  try {
    realRoot = realpathSync(docsRoot)
  } catch {
    return { allowed: false, reason: "docs directory is unavailable" }
  }
  const input = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {}
  const reasons: string[] = []

  let sawPath = false
  for (const field of PATH_FIELDS) {
    if (!(field in input)) continue
    sawPath = true
    const reason = checkPath(input[field], field, realRoot)
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
export function createDocsPreToolUseHook(docsRoot: string) {
  return async function docsPreToolUse(input: unknown): Promise<Record<string, unknown>> {
    const event = (input ?? {}) as { tool_name?: unknown; tool_input?: unknown }
    const decision: GuardDecision =
      typeof event.tool_name === "string" && event.tool_name.length > 0
        ? checkDocsToolUse(event.tool_name, event.tool_input, docsRoot)
        : { allowed: false, reason: "Blocked: malformed tool call" }
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

/** Environment variables the model-facing CLI process must never inherit from the entry process. */
export const AGENT_PRIVATE_ENV = ["AGENT_RUN_TOKEN", "MCP_TOKEN", "MCP_BYPASS_SECRET"]

/** `process.env` minus the entry script's own credentials. ANTHROPIC_API_KEY stays: the CLI cannot call the model without it. */
export function scrubbedAgentEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env }
  for (const name of AGENT_PRIVATE_ENV) delete out[name]
  return out
}
