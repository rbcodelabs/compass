/**
 * Classifies MCP tool names as mutating vs read-only, for the agent audit log
 * (ADR 0001, Phase 5). We audit the agent's mutation tool calls so there's a
 * traceable record of what it changed on a user's behalf.
 *
 * Heuristic rather than a hand-maintained list: any Compass tool whose name
 * does NOT start with a read prefix is treated as a mutation. This errs toward
 * logging (a borderline read gets audited), which is the safe direction for an
 * audit trail and avoids silently missing a newly-added mutating tool.
 */

const READ_PREFIXES = ["get_", "list_", "search_"] as const

export function isMutationTool(name: string): boolean {
  const bare = name.replace(/^mcp__[^_]+__/, "")
  return !READ_PREFIXES.some((p) => bare.startsWith(p))
}

/** Bare tool name without the `mcp__<server>__` prefix, for storage/display. */
export function bareToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, "")
}
