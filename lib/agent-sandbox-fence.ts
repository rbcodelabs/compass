import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { getActiveSchema } from "@/lib/schema"
import { withConflictRetry } from "@/lib/transaction-conflict"

const IN_FLIGHT = ["QUEUED", "RUNNING"]
const RESERVATION_MS = 60_000

type Candidate = {
  id: string
  conversationId: string
  sandboxName: string
  createdAt: Date
}

/** All run starters and persistent sandbox operations write this row before reading their predicates. */
export async function lockSandboxConversation(tx: AppTransactionClient, conversationId: string) {
  const count = await tx.$executeRaw`
    UPDATE ${schemaTable("agent_conversations")}
    SET sandbox_coordination_token = ${randomUUID()}::uuid
    WHERE id = ${conversationId}::uuid
  `
  return count === 1
}

export async function reservePersistentSandboxLaunch(
  prisma: AppPrismaClient,
  conversationId: string,
  runId: string,
  sandboxName: string,
): Promise<string | null> {
  const token = randomUUID()
  return withConflictRetry(() => prisma.$transaction(async (tx) => {
    if (!(await lockSandboxConversation(tx, conversationId))) return null
    if (await tx.agentSandboxOperation.findUnique({ where: { conversationId } })) return null
    const named = await tx.agentRun.updateMany({
      where: { id: runId, conversationId, status: "QUEUED" },
      data: { sandboxName },
    })
    if (named.count !== 1) return null
    await tx.agentSandboxOperation.create({ data: { conversationId, runId, sandboxName, token, phase: "LAUNCHING" } })
    return token
  }))
}

/** Release only after the launch's provider calls have settled successfully. */
export async function releasePersistentSandboxLaunch(prisma: AppPrismaClient, conversationId: string, token: string) {
  await withConflictRetry(() => prisma.agentSandboxOperation.deleteMany({ where: { conversationId, token, phase: "LAUNCHING" } }))
}

function schemaTable(name: "agent_runs" | "agent_sandbox_operations" | "agent_conversations") {
  const schema = getActiveSchema().replaceAll('"', '""')
  return Prisma.raw(`"${schema}"."${name}"`)
}

/**
 * A page consists of eligible generations, never historical turns. A blocked conversation
 * or a generation waiting for its retry time cannot occupy a slot on subsequent ticks.
 */
export async function findPersistentSandboxStopCandidates(
  prisma: AppPrismaClient,
  { now, idleBefore, limit, prefix }: { now: Date; idleBefore: Date; limit: number; prefix: string },
) {
  const runs = schemaTable("agent_runs")
  const operations = schemaTable("agent_sandbox_operations")
  return prisma.$queryRaw<Candidate[]>`
    SELECT r.id, r.conversation_id AS "conversationId", r.sandbox_name AS "sandboxName",
           r.created_at AS "createdAt"
    FROM ${runs} r
    LEFT JOIN ${operations} op ON op.conversation_id = r.conversation_id
    WHERE r.sandbox_name LIKE ${prefix + "%"}
      AND r.sandbox_stopped_at IS NULL
      AND r.finished_at IS NOT NULL
      AND (r.status IN ('FAILED', 'INTERRUPTED', 'CANCELED')
        OR (r.status = 'SUCCEEDED' AND r.finished_at <= ${idleBefore}))
      AND (op.token IS NULL OR (op.run_id = r.id AND (
        op.phase = 'CONFIRMED'
        OR (op.phase IN ('RESERVED', 'RETRY', 'DISPATCHED') AND op.retry_at <= ${now})
      )))
      AND NOT EXISTS (
        SELECT 1 FROM ${runs} active
        WHERE active.conversation_id = r.conversation_id
          AND active.status IN ('QUEUED', 'RUNNING')
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${runs} newer
        WHERE newer.conversation_id = r.conversation_id AND newer.sandbox_name = r.sandbox_name
          AND (newer.created_at, newer.id) > (r.created_at, r.id)
      )
    ORDER BY r.finished_at, r.id
    LIMIT ${limit}
  `
}

/** A prepared stop has done the lookup but has not yet sent a stop. null means already quiescent. */
export type PreparePersistentSandboxStop = (name: string) => Promise<(() => Promise<void>) | null>

export async function stopPersistentSandbox(
  prisma: AppPrismaClient,
  candidate: Candidate,
  now: Date,
  prepare: PreparePersistentSandboxStop,
  isQuiescent: (name: string) => Promise<boolean>,
): Promise<boolean> {
  const { conversationId, id: runId, sandboxName, createdAt } = candidate
  const token = randomUUID()
  const owner = await withConflictRetry(() => prisma.$transaction(async (tx) => {
    if (!(await lockSandboxConversation(tx, conversationId))) return null
    const operation = await tx.agentSandboxOperation.findUnique({ where: { conversationId } })
    if (operation?.runId === runId && (
      operation.phase === "CONFIRMED" ||
      (operation.phase === "DISPATCHED" && operation.retryAt && operation.retryAt <= now)
    )) return operation
    if (operation && (operation.runId !== runId || !["RESERVED", "RETRY"].includes(operation.phase) ||
      !operation.retryAt || operation.retryAt > now)) return null
    const current = await tx.agentRun.findUnique({ where: { id: runId }, select: { sandboxStoppedAt: true } })
    if (!current || current.sandboxStoppedAt) return null
    const newer = await tx.agentRun.findFirst({
      where: {
        conversationId,
        id: { not: runId },
        OR: [
          { status: { in: IN_FLIGHT } },
          { sandboxName, createdAt: { gt: createdAt } },
          { sandboxName, createdAt, id: { gt: runId } },
        ],
      },
      select: { id: true },
    })
    if (newer) return null
    const data = { runId, sandboxName, token, phase: "RESERVED", retryAt: new Date(now.getTime() + RESERVATION_MS) }
    return operation
      ? tx.agentSandboxOperation.update({ where: { conversationId }, data })
      : tx.agentSandboxOperation.create({ data: { conversationId, ...data } })
  }))
  if (!owner) return false

  const claim = { conversationId, token: owner.token }
  if (owner.phase === "DISPATCHED") {
    // Only observe. Never send an additional stop on an indeterminate generation.
    // The original request is pinned to one provider session; a stopped session
    // cannot host a resumed turn. A missing named sandbox alone proves nothing.
    const polled = await withConflictRetry(() => prisma.agentSandboxOperation.updateMany({
      where: { ...claim, phase: "DISPATCHED", retryAt: owner.retryAt },
      data: { retryAt: new Date(now.getTime() + RESERVATION_MS) },
    }))
    if (polled.count !== 1 || !(await isQuiescent(sandboxName))) return false
  } else if (owner.phase === "RESERVED") {
    let stop: Awaited<ReturnType<PreparePersistentSandboxStop>>
    try {
      stop = await prepare(sandboxName)
    } catch (error) {
      // Lookup failed before any stop was issued. Back off without removing the fence.
      await withConflictRetry(() => prisma.agentSandboxOperation.updateMany({
        where: { ...claim, phase: "RESERVED" },
        data: { phase: "RETRY", retryAt: new Date(now.getTime() + RESERVATION_MS) },
      }))
      throw error
    }
    const { count } = await withConflictRetry(() => prisma.agentSandboxOperation.updateMany({
      where: { ...claim, phase: "RESERVED" },
      data: { phase: "DISPATCHED", retryAt: new Date(now.getTime() + RESERVATION_MS) },
    }))
    if (count !== 1) return false
    // An exception or crash from here through confirmation leaves the fence intact.
    // A clock timeout cannot prove the provider request will never take effect.
    if (stop) await stop()
  }
  if (owner.phase !== "CONFIRMED") {
    const confirmed = await withConflictRetry(() => prisma.agentSandboxOperation.updateMany({
      where: { ...claim, phase: "DISPATCHED" },
      data: { phase: "CONFIRMED" },
    }))
    if (confirmed.count !== 1) return false
  }

  return withConflictRetry(() => prisma.$transaction(async (tx) => {
    const released = await tx.agentSandboxOperation.deleteMany({ where: { ...claim, phase: "CONFIRMED" } })
    if (released.count !== 1) return false
    await tx.agentRun.updateMany({
      where: { id: runId, conversationId, sandboxName, sandboxStoppedAt: null },
      data: { sandboxStoppedAt: now, updatedAt: now },
    })
    return true
  }))
}
