/**
 * Pure decisions for reusing one Vercel Sandbox across the turns of a conversation
 * (ADR "Agent sandbox reuse lifecycle", see the Compass Architecture Decisions doc).
 *
 * No SDK import on purpose: everything here is a function of plain values, so the
 * hit / miss / mismatch matrix is unit-testable without a sandbox, and
 * lib/agent-runs.ts can share the constants without an import cycle through
 * lib/agent-sandbox.ts.
 */
import { createHash } from "node:crypto"

/**
 * How long a stopped conversation sandbox's disk (the user's repo clones) is kept. Conversation sandboxes are
 * persistent: stopping one snapshots its filesystem, and the next turn resumes it from that snapshot.
 */
export const AGENT_SANDBOX_RETENTION_MS = 7 * 24 * 60 * 60_000

/** How long a conversation sandbox may sit unused before the sweeper stops (pauses) it. */
export const AGENT_SANDBOX_IDLE_MS = 5 * 60_000

/**
 * Kill switch. Reuse is ON unless AGENT_SANDBOX_REUSE is "0" (or "false"/"off"), which restores
 * the one-sandbox-per-run behaviour exactly.
 */
export function agentSandboxReuseEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.AGENT_SANDBOX_REUSE?.trim().toLowerCase()
  return !(value === "0" || value === "false" || value === "off")
}

/**
 * The network-policy profile a sandbox was created with. Egress is fixed at creation, so a sandbox
 * can only be reused by a turn that wants the same one. A shell-enabled turn's allowlist depends on
 * the Compass host and the model provider, so the profile hashes the policy itself rather than
 * naming a mode.
 */
export function sandboxNetworkProfile(policy: unknown): string {
  if (!policy) return "open"
  return `restricted-${createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 12)}`
}

/** What the platform says about a sandbox that already exists under the conversation's name. */
export type ExistingSandboxState = {
  status: string
  tags?: Record<string, string>
}

/**
 * The conversation's previous run. A sandbox is only trusted when that run finished cleanly on it:
 * anything else (failed, interrupted, canceled, never finished) leaves the sandbox in an unknown
 * state, and finalize stops those. This is the independent check that does not depend on that stop
 * having succeeded.
 */
export type PreviousRunState = {
  status: string
  finishedAt: Date | null
  sandboxName: string | null
}

export type SandboxReuseReason =
  | "hit"
  | "resumed"
  | "disabled"
  | "not-found"
  | "not-running"
  | "policy-mismatch"
  | "previous-run-not-clean"
  | "lookup-failed"

/**
 * What to do with the conversation's sandbox. Its filesystem is the user's work (repo clones) and must
 * never be discarded to fix a mismatch, so there are only two ways to reuse it:
 *   - "warm":   still running, last turn finished cleanly inside the idle window: use as is.
 *   - "resume": anything else that exists. A running-but-untrusted sandbox is stopped first (which ends its
 *               processes and snapshots its disk); a stopped one comes back from its persisted disk. Either way
 *               the egress policy is re-applied before the turn, and per-turn files are wiped.
 * "boot" is only for a conversation that has no sandbox yet (or reuse switched off).
 */
export type SandboxReuseDecision =
  | { action: "warm"; reuse: true; reason: "hit" }
  | { action: "resume"; reuse: true; reason: Exclude<SandboxReuseReason, "hit" | "disabled" | "not-found" | "lookup-failed"> }
  | { action: "boot"; reuse: false; reason: "disabled" | "not-found" }

export function decideSandboxReuse(input: {
  enabled: boolean
  existing: ExistingSandboxState | null
  profile: string
  name: string
  previous: PreviousRunState | null
}): SandboxReuseDecision {
  if (!input.enabled) return { action: "boot", reuse: false, reason: "disabled" }
  if (!input.existing) return { action: "boot", reuse: false, reason: "not-found" }
  if (input.existing.status !== "running") return { action: "resume", reuse: true, reason: "resumed" }
  if (input.existing.tags?.profile !== input.profile) return { action: "resume", reuse: true, reason: "policy-mismatch" }
  const previous = input.previous
  if (!previous || previous.status !== "SUCCEEDED" || previous.sandboxName !== input.name || !previous.finishedAt) {
    return { action: "resume", reuse: true, reason: "previous-run-not-clean" }
  }
  return { action: "warm", reuse: true, reason: "hit" }
}

/**
 * Paths (relative to the sandbox working directory) that belong to ONE turn and are wiped before
 * a reused sandbox is handed the next turn's files. The docs tree is rebuilt from the database
 * every turn, so a doc deleted since the last turn must not linger. Deliberately absent:
 * `repos/` (the agent's clones, AGENT_REPOS_DIR) and everything else the user's work produced.
 */
export const PER_TURN_SANDBOX_PATHS: readonly string[] = [
  "docs",
  "docs-manifest.json",
  "session-in.jsonl.gz",
  "session-out.jsonl.gz",
  "fallback-prompt.txt",
  "capability-packs",
]

/** Unix account that Bash commands run as (scripts/agent/github-access.ts JAIL_USER). */
const JAIL_USER = "agentbash"

/**
 * The shell run (with sudo) before a reused sandbox gets its next turn: end anything left from the
 * previous turn, then remove the per-turn files. `[n]ode` stops pkill matching this script's own
 * command line.
 */
export function reusedSandboxCleanupScript(root: string): string {
  const paths = PER_TURN_SANDBOX_PATHS.map((p) => `${root}/${p}`).join(" ")
  return [
    "pkill -KILL -f '[n]ode entry.ts' || true",
    `pkill -KILL -u ${JAIL_USER} || true`,
    `rm -rf ${paths}`,
  ].join("\n")
}
