/**
 * The models a cloud agent may be configured with (ADR "Cloud agents as first-class identities").
 *
 * `agents.model` is free text in the database, and lib/agent-harness.ts (agentModelForHarness) re-checks it by SHAPE at run
 * time and ignores anything the active harness cannot serve. That is the last line of defence. This module is the FIRST:
 * what the management UI offers and what the server actions accept, so a typo or a hand-edited request is refused at write
 * time instead of silently running on the deployment default.
 *
 * The allowed set is a short, reviewed list. A deployment can extend it (never shrink the shape rules) with
 * COMPASS_CLOUD_AGENT_MODELS, a comma-separated list; each entry must still pass the same shape check, which keeps shell
 * metacharacters and whitespace out of a value that is later forwarded into a sandbox environment.
 */

export type AgentModelOption = { value: string; label: string }

/** Claude harness ids (the default harness only holds an Anthropic key) and the opencode gateway reference. */
export const BUILT_IN_AGENT_MODELS: readonly AgentModelOption[] = [
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { value: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5 (AI Gateway)" },
]

/** Same shape rule as agentModelForHarness, minus the harness-specific half. */
const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/

function extraModels(env: Record<string, string | undefined>): AgentModelOption[] {
  return (env.COMPASS_CLOUD_AGENT_MODELS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => MODEL_SHAPE.test(value))
    .map((value) => ({ value, label: value }))
}

/** The options a picker shows (the system default is "no value" and is offered separately). */
export function allowedAgentModels(env: Record<string, string | undefined> = process.env): AgentModelOption[] {
  const seen = new Set<string>()
  return [...BUILT_IN_AGENT_MODELS, ...extraModels(env)].filter((option) => (seen.has(option.value) ? false : (seen.add(option.value), true)))
}

/**
 * Normalizes a requested model for storage: blank or null = the system default (stored as null); a value in the allowed set
 * is returned trimmed; anything else throws.
 */
export function parseAgentModel(value: unknown, env: Record<string, string | undefined> = process.env): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new Error("Choose one of the available models")
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!allowedAgentModels(env).some((option) => option.value === trimmed)) throw new Error("Choose one of the available models")
  return trimmed
}
