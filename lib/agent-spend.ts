/**
 * The single definition of "agent spend" (ADR-0032, TASK-40).
 *
 * A detached run records its cost on agent_runs AND on the assistant message it creates, so adding both tables
 * double-counts. The rule here counts each unit of spend once:
 *
 *   spend = cost of every AgentRun in the window
 *         + cost of every assistant AgentMessage in the window that has NO run (inline turns, and every message
 *           that predates migration 129 and so carries run_id NULL).
 *
 * Missing cost is never treated as zero. Terminal runs and run-less assistant messages with a NULL cost are
 * counted, so a caller can mark the window PARTIAL instead of presenting a total that is quietly too low.
 *
 * Legacy messages (run_id NULL) from detached runs also have a matching run row, so any window that starts before
 * the capture fix was deployed can count those runs twice. legacyOverlapPossible says so; it is true unless
 * AGENT_COST_CAPTURE_STARTED_AT is set and the whole window is on or after it. There is no backfill.
 */

import type { AppPrismaClient } from "@/lib/db"

export type SpendRow = {
  /** UTC calendar day of the run or message creation (YYYY-MM-DD). */
  date: string
  source: "run" | "message"
  userId: string | null
  agentId: string | null
  kind: string
  model: string | null
  costUsd: number | null
}

export type SpendRows = {
  rows: SpendRow[]
  /** Terminal runs that reported no cost (including swept/interrupted runs). */
  nullCostRuns: number
  /** Run-less assistant messages with no cost (e.g. an inline turn that failed). */
  nullCostMessages: number
  legacyOverlapPossible: boolean
}

type SpendPrisma = Pick<AppPrismaClient, "agentRun" | "agentMessage">

const TERMINAL_RUN_STATUSES = ["SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELED"]

const utcDay = (d: Date) => d.toISOString().slice(0, 10)

/** The deploy-time timestamp from which every new message carries its run id. Unset means unknown, i.e. possible overlap. */
export function costCaptureStartedAt(env: NodeJS.ProcessEnv = process.env): Date | null {
  const raw = env.AGENT_COST_CAPTURE_STARTED_AT
  if (!raw) return null
  const d = new Date(raw)
  return Number.isFinite(d.getTime()) ? d : null
}

export async function fetchSpendRows(
  prisma: SpendPrisma,
  input: { workspaceId: string; since: Date; until: Date; captureStartedAt?: Date | null },
): Promise<SpendRows> {
  const { workspaceId, since, until } = input
  const createdAt = { gte: since, lt: until }
  const [runs, messages] = await Promise.all([
    prisma.agentRun.findMany({
      where: { workspaceId, createdAt },
      select: { createdAt: true, status: true, userId: true, agentId: true, kind: true, model: true, costUsd: true },
    }),
    prisma.agentMessage.findMany({
      where: { role: "assistant", runId: null, createdAt, conversation: { workspaceId } },
      select: { createdAt: true, authorUserId: true, model: true, costUsd: true, conversation: { select: { userId: true } } },
    }),
  ])

  const rows: SpendRow[] = []
  let nullCostRuns = 0
  let nullCostMessages = 0
  for (const run of runs) {
    const terminal = TERMINAL_RUN_STATUSES.includes(run.status)
    if (run.costUsd == null && !terminal) continue // still running: no cost yet is expected
    if (run.costUsd == null) nullCostRuns++
    rows.push({ date: utcDay(run.createdAt), source: "run", userId: run.userId, agentId: run.agentId ?? null, kind: run.kind, model: run.model ?? null, costUsd: run.costUsd ?? null })
  }
  for (const message of messages) {
    if (message.costUsd == null) nullCostMessages++
    rows.push({
      date: utcDay(message.createdAt),
      source: "message",
      userId: message.authorUserId ?? message.conversation.userId,
      agentId: null,
      kind: "CHAT",
      model: message.model ?? null,
      costUsd: message.costUsd ?? null,
    })
  }

  const captureStartedAt = input.captureStartedAt === undefined ? costCaptureStartedAt() : input.captureStartedAt
  const legacyOverlapPossible = !captureStartedAt || since < captureStartedAt
  return { rows, nullCostRuns, nullCostMessages, legacyOverlapPossible }
}
