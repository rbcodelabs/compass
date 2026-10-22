/**
 * Per-user guardrails for agent turns (ADR 0001, Phase 5).
 *
 * A rolling 24h window caps both the number of turns and the total agent spend
 * per user, so a runaway loop or abuse can't rack up unbounded Anthropic cost.
 * Usage is derived from persisted assistant turns (AgentMessage.costUsd), joined
 * to the user who asked for the turn (`author_user_id`), falling back to the
 * conversation's owner for rows that predate shared conversations and so carry none.
 * In a shared conversation that means each person spends their own allowance, not
 * the owner's.
 *
 * Limits are configurable via env; the defaults are deliberately generous for a
 * single-tenant deploy and easy to tighten later.
 */

import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { LIVE_AGENT_RUN_STATUSES } from "@/lib/agent-run-identity"

const WINDOW_MS = 24 * 60 * 60 * 1000

function maxTurnsPerWindow(): number {
  const v = Number(process.env.AGENT_MAX_TURNS_PER_DAY)
  return Number.isFinite(v) && v > 0 ? v : 100
}
function maxCostUsdPerWindow(): number {
  const v = Number(process.env.AGENT_MAX_COST_USD_PER_DAY)
  return Number.isFinite(v) && v > 0 ? v : 10
}

export type LimitResult = { allowed: true } | { allowed: false; reason: string }

/**
 * Check whether `userId` may start another agent turn. Counts this user's
 * assistant turns and summed cost in the trailing 24h window.
 */
export async function checkAgentUsageLimit(userId: string): Promise<LimitResult> {
  const prisma = getPrisma()
  const since = new Date(Date.now() - WINDOW_MS)
  const sum = { _count: { _all: true }, _sum: { costUsd: true } } as const
  const agg = await prisma.agentMessage
    .aggregate({
      where: {
        role: "assistant",
        createdAt: { gte: since },
        OR: [{ authorUserId: userId }, { authorUserId: null, conversation: { userId } }],
      },
      ...sum,
    })
    .catch((error: unknown) => {
      // Migration 080 not applied yet: the column does not exist, and before it
      // every conversation had exactly one person in it, so the owner query is exact.
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
      if (code !== "P2021" && code !== "P2022") throw error
      return prisma.agentMessage.aggregate({
        where: { role: "assistant", createdAt: { gte: since }, conversation: { userId } },
        ...sum,
      })
    })
  const turns = agg._count._all
  const cost = agg._sum.costUsd ?? 0

  const turnCap = maxTurnsPerWindow()
  if (turns >= turnCap) {
    return { allowed: false, reason: `Daily agent turn limit reached (${turnCap}/day). Try again tomorrow.` }
  }
  const costCap = maxCostUsdPerWindow()
  if (cost >= costCap) {
    return { allowed: false, reason: `Daily agent spend limit reached ($${costCap}/day). Try again tomorrow.` }
  }
  return { allowed: true }
}

// ── Per-agent run caps (cloud agents, phase 4) ──────────────────────────────
//
// The per-user guardrail above bounds what one PERSON can spend. A named agent can be started by many people (and by an
// assignment, with no one watching), so it also carries its own caps, counted from agent_runs by agent_id:
//
//   concurrent  runs of this agent that are not terminal (QUEUED or RUNNING)
//   daily       runs of this agent created in the trailing 24 hours, whatever their outcome
//
// Both are configurable per agent by whoever manages it (agents.max_concurrent_runs / max_runs_per_day, migration 102);
// NULL means the default. The built-in agent (no agent id) is not capped here: it stays under the per-user limit.
//
// The check is a read followed by a later write, so two requests at the same instant can both pass it and overshoot by
// the number of racers. That is acceptable for a spend guardrail (the per-user limit above works the same way) and is
// cheaper than serialising run creation; the cap is a ceiling on sustained load, not a hard lock.

export const DEFAULT_AGENT_MAX_CONCURRENT_RUNS = 5
export const DEFAULT_AGENT_MAX_RUNS_PER_DAY = 100
/** What an administrator may configure: positive whole numbers up to these ceilings. */
export const AGENT_CAP_CEILINGS = { maxConcurrentRuns: 50, maxRunsPerDay: 5000 } as const

export type AgentRunCaps = {
  /** Effective values: the configured cap, or the default when none is set (or migration 102 is not applied). */
  maxConcurrentRuns: number
  maxRunsPerDay: number
  /** What is stored; null = using the default. */
  configuredMaxConcurrentRuns: number | null
  configuredMaxRunsPerDay: number | null
}

export type AgentCapKind = "CONCURRENT" | "DAILY"
export type AgentCapResult = { allowed: true } | { allowed: false; cap: AgentCapKind; limit: number; reason: string }

function isMissingColumn(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
  return code === "P2022" || code === "P2021"
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

/** The agent's effective caps. Tolerates migration 102 being unapplied (both caps are then the defaults). */
export async function getAgentRunCaps(prisma: Pick<AppPrismaClient, "agent">, agentId: string): Promise<AgentRunCaps> {
  let row: { maxConcurrentRuns: number | null; maxRunsPerDay: number | null } | null = null
  try {
    row = await prisma.agent.findFirst({ where: { id: agentId }, select: { maxConcurrentRuns: true, maxRunsPerDay: true } })
  } catch (error) {
    if (!isMissingColumn(error)) throw error
  }
  const configuredMaxConcurrentRuns = positiveInt(row?.maxConcurrentRuns)
  const configuredMaxRunsPerDay = positiveInt(row?.maxRunsPerDay)
  return {
    maxConcurrentRuns: configuredMaxConcurrentRuns ?? DEFAULT_AGENT_MAX_CONCURRENT_RUNS,
    maxRunsPerDay: configuredMaxRunsPerDay ?? DEFAULT_AGENT_MAX_RUNS_PER_DAY,
    configuredMaxConcurrentRuns,
    configuredMaxRunsPerDay,
  }
}

/**
 * The stored caps of several agents, for the settings pages. Tolerates migration 102 being unapplied (every agent then reads as
 * "using the defaults"); only editors are sent these.
 */
export async function loadConfiguredAgentRunCaps(prisma: Pick<AppPrismaClient, "agent">, agentIds: string[]): Promise<Map<string, { maxConcurrentRuns: number | null; maxRunsPerDay: number | null }>> {
  const caps = new Map<string, { maxConcurrentRuns: number | null; maxRunsPerDay: number | null }>();
  if (agentIds.length === 0) return caps;
  try {
    const rows = await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, maxConcurrentRuns: true, maxRunsPerDay: true } });
    for (const row of rows) caps.set(row.id, { maxConcurrentRuns: positiveInt(row.maxConcurrentRuns), maxRunsPerDay: positiveInt(row.maxRunsPerDay) });
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
  }
  return caps;
}

/**
 * Normalises a cap an administrator typed: null/undefined/"" clears it (back to the default); otherwise a whole number from 1 up
 * to the ceiling. Anything else throws, so a hand-edited request cannot store 0, a fraction, a negative or an absurd value.
 */
export function parseAgentCap(value: unknown, kind: keyof typeof AGENT_CAP_CEILINGS): number | null {
  if (value === undefined || value === null || value === "") return null
  const label = kind === "maxConcurrentRuns" ? "Concurrent run limit" : "Daily run limit"
  const ceiling = AGENT_CAP_CEILINGS[kind]
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ceiling) throw new Error(`${label} must be a whole number from 1 to ${ceiling}`)
  return value
}

/**
 * May `agentId` start another run? Counts only that agent's runs, so one busy agent never uses another's allowance.
 * A run attributed to no agent (agent_id NULL: the built-in assistant, or a database without migration 100) is not counted.
 */
export async function checkAgentRunCaps(prisma: Pick<AppPrismaClient, "agent" | "agentRun">, agentId: string, now: Date = new Date()): Promise<AgentCapResult> {
  const caps = await getAgentRunCaps(prisma, agentId)
  let active: number
  let today: number
  try {
    ;[active, today] = await Promise.all([
      prisma.agentRun.count({ where: { agentId, status: { in: [...LIVE_AGENT_RUN_STATUSES] } } }),
      prisma.agentRun.count({ where: { agentId, createdAt: { gte: new Date(now.getTime() - WINDOW_MS) } } }),
    ])
  } catch (error) {
    // Without migration 100 no run can be attributed to an agent, so there is nothing to count.
    if (!isMissingColumn(error)) throw error
    return { allowed: true }
  }
  if (active >= caps.maxConcurrentRuns) {
    return { allowed: false, cap: "CONCURRENT", limit: caps.maxConcurrentRuns, reason: `This agent already has ${active} runs in progress (limit ${caps.maxConcurrentRuns}). Wait for one to finish, or ask an administrator to raise the limit.` }
  }
  if (today >= caps.maxRunsPerDay) {
    return { allowed: false, cap: "DAILY", limit: caps.maxRunsPerDay, reason: `This agent has reached its daily limit of ${caps.maxRunsPerDay} runs. Try again later, or ask an administrator to raise the limit.` }
  }
  return { allowed: true }
}

/** The 429 body an API route returns when an agent cap refuses a run. */
export function agentCapReachedBody(result: Extract<AgentCapResult, { allowed: false }>) {
  return { error: result.reason, code: "AGENT_CAP_REACHED" as const, cap: result.cap, limit: result.limit }
}
