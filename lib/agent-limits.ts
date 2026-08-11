/**
 * Per-user guardrails for agent turns (ADR 0001, Phase 5).
 *
 * A rolling 24h window caps both the number of turns and the total agent spend
 * per user, so a runaway loop or abuse can't rack up unbounded Anthropic cost.
 * Usage is derived from persisted assistant turns (AgentMessage.costUsd), joined
 * to the owning user via the conversation.
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
  const agg = await prisma.agentMessage.aggregate({
    where: { role: "assistant", createdAt: { gte: since }, conversation: { userId } },
    _count: { _all: true },
    _sum: { costUsd: true },
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
