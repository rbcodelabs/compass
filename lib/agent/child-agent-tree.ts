/**
 * Pure parent/child sub-agent tree model, ported from Geode's `agentTreeModel.ts` for Compass's
 * durable `AgentChildRun` projection and live `Subagent` stream.
 *
 * Client-and-server safe (zero DB imports). Handles self-parenting and multi-node cycles once in
 * `resolveEffectiveParents` / `buildAgentBreadcrumbs` so every consumer (composer popover, board
 * counts, and sticky breadcrumb bar) is immune to malformed harness parent references.
 */

import type { Subagent, ToolStep } from "@/lib/agent-run-stream"

export type ChildAgentStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED"

export type SerializedChildAgentRun = {
  id: string
  conversationId: string
  runId: string
  nativeAgentId: string
  parentChildRunId: string | null
  parentNativeAgentId: string | null
  role: string
  description: string
  status: ChildAgentStatus
  currentActivity: string | null
  stepCount: number
  steps: ToolStep[]
  resultSummary: string | null
  startedAt: string
  finishedAt: string | null
  updatedAt: string
}

export const ACTIVE_CHILD_AGENT_STATUSES: ReadonlySet<ChildAgentStatus> = new Set<ChildAgentStatus>(["RUNNING"])

/** One row of the flattened sub-agent tree, carrying its 1-based depth for `aria-level` and indentation. */
export type AgentTreeRow = {
  run: SerializedChildAgentRun
  level: number
}

export type AgentTeamTone = "active" | "failed" | "done" | "idle"

export type AgentTeamSummary = {
  total: number
  active: number
  failed: number
  /** Human-readable composer pill text, e.g. "2 agents working" or "3 agents". */
  label: string
  tone: AgentTeamTone
}

/** Generic SDK fallback roles/descriptions that should yield to a concrete description when present. */
const GENERIC_ROLE = /^(?:general[-_\s]?purpose|sub-?agent|default)$/i
const GENERIC_DESCRIPTION = /^(?:codex\s+sub-?agent\b|sub-?agent$)/i

const STATUS_LABELS: Record<ChildAgentStatus, string> = {
  RUNNING: "Working",
  SUCCEEDED: "Done",
  FAILED: "Failed",
  INTERRUPTED: "Interrupted",
}

export function formatChildAgentStatus(status: ChildAgentStatus): string {
  return STATUS_LABELS[status] ?? status
}

/**
 * Resolves a run's declared parent id within `runs`, falling back from `parentChildRunId` to
 * `(runId, parentNativeAgentId)` so live client-streamed subagents and server-projected rows link up
 * even before the parent row's database UUID is persisted.
 */
function declaredParentIdOf(
  run: SerializedChildAgentRun,
  byId: ReadonlyMap<string, SerializedChildAgentRun>,
  byRunAndNative: ReadonlyMap<string, SerializedChildAgentRun>,
): string | undefined {
  if (run.parentChildRunId && byId.has(run.parentChildRunId)) {
    return run.parentChildRunId
  }
  if (run.parentNativeAgentId) {
    const match = byRunAndNative.get(`${run.runId}\u0000${run.parentNativeAgentId}`)
    if (match) return match.id
  }
  return undefined
}

/**
 * Resolves each run's usable parent id, breaking self-references and cycles by promoting cycle
 * members to roots rather than dropping them or looping indefinitely.
 */
export function resolveEffectiveParents(runs: readonly SerializedChildAgentRun[]): Map<string, string | undefined> {
  const byId = new Map(runs.map((run) => [run.id, run]))
  const byRunAndNative = new Map(runs.map((run) => [`${run.runId}\u0000${run.nativeAgentId}`, run]))
  const parents = new Map<string, string | undefined>()

  for (const run of runs) {
    const declared = declaredParentIdOf(run, byId, byRunAndNative)
    if (!declared || declared === run.id || !byId.has(declared)) {
      parents.set(run.id, undefined)
      continue
    }

    const seen = new Set<string>()
    let cursor: string | undefined = declared
    let cyclic = false
    while (cursor) {
      if (cursor === run.id) {
        cyclic = true
        break
      }
      if (seen.has(cursor)) break
      seen.add(cursor)
      const node = byId.get(cursor)
      cursor = node ? declaredParentIdOf(node, byId, byRunAndNative) : undefined
    }
    parents.set(run.id, cyclic ? undefined : declared)
  }

  return parents
}

/**
 * Depth-first pre-order flattening of the parent/child sub-agent graph, preserving the caller's
 * chronological ordering within each sibling group. Orphans and cycle members surface as roots.
 */
export function flattenAgentTree(runs: readonly SerializedChildAgentRun[]): AgentTreeRow[] {
  if (runs.length === 0) return []
  const parents = resolveEffectiveParents(runs)
  const children = new Map<string | undefined, SerializedChildAgentRun[]>()
  for (const run of runs) {
    const parent = parents.get(run.id)
    const bucket = children.get(parent) ?? []
    bucket.push(run)
    children.set(parent, bucket)
  }

  const rows: AgentTreeRow[] = []
  const visited = new Set<string>()
  const walk = (parentId: string | undefined, level: number): void => {
    for (const run of children.get(parentId) ?? []) {
      if (visited.has(run.id)) continue
      visited.add(run.id)
      rows.push({ run, level })
      walk(run.id, level + 1)
    }
  }
  walk(undefined, 1)

  for (const run of runs) {
    if (visited.has(run.id)) continue
    visited.add(run.id)
    rows.push({ run, level: 1 })
  }
  return rows
}

/** Direct children of `parentId` in chronological order, using cycle-safe parent resolution. */
export function listDirectChildRuns(
  runs: readonly SerializedChildAgentRun[],
  parentId: string,
): SerializedChildAgentRun[] {
  if (runs.length === 0) return []
  const parents = resolveEffectiveParents(runs)
  return runs.filter((run) => parents.get(run.id) === parentId)
}

/** Counts and composer pill label/tone for a conversation's sub-agent team. */
export function summarizeAgentTeam(runs: readonly SerializedChildAgentRun[]): AgentTeamSummary {
  const total = runs.length
  const active = runs.filter((run) => ACTIVE_CHILD_AGENT_STATUSES.has(run.status)).length
  const failed = runs.filter((run) => run.status === "FAILED").length

  if (active > 0) {
    return {
      total,
      active,
      failed,
      label: `${active} ${active === 1 ? "agent" : "agents"} working`,
      tone: "active",
    }
  }
  if (failed > 0) {
    return {
      total,
      active,
      failed,
      label: `${failed} ${failed === 1 ? "agent" : "agents"} failed`,
      tone: "failed",
    }
  }
  if (total > 0) {
    return {
      total,
      active,
      failed,
      label: `${total} ${total === 1 ? "agent" : "agents"}`,
      tone: runs.every((run) => run.status === "SUCCEEDED") ? "done" : "idle",
    }
  }
  return { total: 0, active: 0, failed: 0, label: "No agents", tone: "idle" }
}

/**
 * Primary display name for a sub-agent. Prefers a specific harness role (`Explore`, `Plan`,
 * `Security Auditor`), falling back to `description` when the role is a generic SDK default such as
 * `general-purpose`.
 */
export function agentLabel(run: Pick<SerializedChildAgentRun, "role" | "description">): string {
  const role = run.role?.trim()
  const description = run.description?.trim()
  if (role && !GENERIC_ROLE.test(role)) return role
  if (description && !GENERIC_DESCRIPTION.test(description)) return description
  if (role) return role
  return "Sub-agent"
}

/** Secondary line for popover rows: live activity when known, else description, else humanized status. */
export function agentSubLabel(
  run: Pick<SerializedChildAgentRun, "role" | "description" | "currentActivity" | "status">,
): string {
  const activity = run.currentActivity?.trim()
  if (activity && run.status === "RUNNING") return activity
  const description = run.description?.trim()
  if (description && description !== agentLabel(run)) return description
  if (activity) return activity
  return formatChildAgentStatus(run.status)
}

/**
 * Root-to-selected ancestor chain for the sticky breadcrumb bar.
 * Returns an empty array when nothing is selected or `selectedId` is absent from `runs`.
 */
export function buildAgentBreadcrumbs(
  runs: readonly SerializedChildAgentRun[],
  selectedId: string | null | undefined,
): SerializedChildAgentRun[] {
  if (!selectedId || runs.length === 0) return []
  const byId = new Map(runs.map((run) => [run.id, run]))
  const parents = resolveEffectiveParents(runs)
  const chain: SerializedChildAgentRun[] = []
  const visited = new Set<string>()
  let cursor = byId.get(selectedId)
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id)
    chain.unshift(cursor)
    const parentId = parents.get(cursor.id)
    cursor = parentId ? byId.get(parentId) : undefined
  }
  return chain
}

function mapLiveStepStatus(status: Subagent["status"]): ChildAgentStatus {
  if (status === "running") return "RUNNING"
  if (status === "error") return "FAILED"
  return "SUCCEEDED"
}

function latestStepActivity(steps: readonly ToolStep[]): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.status === "running") {
      return step.detail ? `${step.label} · ${step.detail}` : step.label
    }
  }
  return null
}

/**
 * Overlays live client-streamed `Subagent`s from the active turn onto durable `AgentChildRun` rows
 * loaded from the server, matching on `(runId, nativeAgentId)` so the composer pill, popover tree,
 * and drill-down timeline reflect in-flight tool steps with zero latency and survive reloads.
 */
export function mergeChildAgentRuns({
  durableRuns,
  conversationId,
  activeRunId,
  liveSubagents,
  nowIso,
}: {
  durableRuns: readonly SerializedChildAgentRun[]
  conversationId: string | null
  activeRunId: string | null
  liveSubagents: readonly Subagent[]
  nowIso?: string
}): SerializedChildAgentRun[] {
  if (!conversationId || !activeRunId || liveSubagents.length === 0) {
    return [...durableRuns]
  }

  const fallbackNow = nowIso ?? new Date().toISOString()
  const merged = durableRuns.map((run) => ({ ...run }))
  const indexByNative = new Map<string, number>()
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].runId === activeRunId) {
      indexByNative.set(merged[i].nativeAgentId, i)
    }
  }

  for (const sub of liveSubagents) {
    const status = mapLiveStepStatus(sub.status)
    const activity = status === "RUNNING" ? latestStepActivity(sub.steps) : null
    const existingIdx = indexByNative.get(sub.id)
    if (existingIdx !== undefined) {
      const existing = merged[existingIdx]
      merged[existingIdx] = {
        ...existing,
        parentNativeAgentId: sub.parentToolUseId ?? existing.parentNativeAgentId,
        role: sub.agentType || existing.role,
        description: sub.description || existing.description,
        status: existing.status !== "RUNNING" && status === "RUNNING" ? existing.status : status,
        currentActivity: activity ?? (status === "RUNNING" ? existing.currentActivity : null),
        stepCount: Math.max(existing.stepCount, sub.steps.length),
        steps: sub.steps.length >= existing.steps.length ? [...sub.steps] : existing.steps,
        resultSummary: sub.summary ?? existing.resultSummary,
      }
    } else {
      const syntheticId = `live:${activeRunId}:${sub.id}`
      indexByNative.set(sub.id, merged.length)
      merged.push({
        id: syntheticId,
        conversationId,
        runId: activeRunId,
        nativeAgentId: sub.id,
        parentChildRunId: null,
        parentNativeAgentId: sub.parentToolUseId ?? null,
        role: sub.agentType || "general-purpose",
        description: sub.description || "Subagent",
        status,
        currentActivity: activity,
        stepCount: sub.steps.length,
        steps: [...sub.steps],
        resultSummary: sub.summary ?? null,
        startedAt: fallbackNow,
        finishedAt: status === "RUNNING" ? null : fallbackNow,
        updatedAt: fallbackNow,
      })
    }
  }

  return merged
}
