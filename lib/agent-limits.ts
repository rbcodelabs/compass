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

import getPrisma from "@/lib/db"

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
