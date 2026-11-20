import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { getActiveSchema } from "@/lib/schema"
import { withConflictRetry } from "@/lib/transaction-conflict"

const IN_FLIGHT = ["QUEUED", "RUNNING"]
const RETRY_MS = 60_000

type Candidate = {
  id: string
  conversationId: string
  sandboxName: string
  createdAt: Date
}

function schemaTable(name: "agent_runs" | "agent_sandbox_operations" | "agent_sandbox_generations" | "agent_conversations") {
  const schema = getActiveSchema().replaceAll('"', '""')
  return Prisma.raw(`"${schema}"."${name}"`)
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
  now = new Date(),
): Promise<string | null> {
  const token = randomUUID()
  return withConflictRetry(() => prisma.$transaction(async (tx) => {
    if (!(await lockSandboxConversation(tx, conversationId))) return null
    if (await tx.agentSandboxOperation.findUnique({ where: { conversationId } })) return null
    const run = await tx.agentRun.findFirst({ where: { id: runId, conversationId, status: "QUEUED" }, select: { id: true } })
    if (!run) return null
    await tx.agentSandboxOperation.create({
      data: { conversationId, runId, sandboxName, token, phase: "LAUNCH_PREPARED", retryAt: new Date(now.getTime() + RETRY_MS) },
    })
    return token
  }))
}

/** Bind the sandbox name and durable generation before the caller can contact the provider. */
export async function dispatchPersistentSandboxLaunch(
  prisma: AppPrismaClient,
  conversationId: string,
  runId: string,
  sandboxName: string,
  token: string,
) {
  return withConflictRetry(() => prisma.$transaction(async (tx) => {
    if (!(await lockSandboxConversation(tx, conversationId))) return false
    const operation = await tx.agentSandboxOperation.findUnique({ where: { conversationId } })
    if (operation?.token !== token || operation.phase !== "LAUNCH_PREPARED") return false
    const named = await tx.agentRun.updateMany({
      where: { id: runId, conversationId, status: "QUEUED" },
      data: { sandboxName },
    })
    if (named.count !== 1) return false
    const changed = await tx.agentSandboxOperation.updateMany({
      where: { conversationId, token, phase: "LAUNCH_PREPARED" },
      data: { phase: "LAUNCHING", retryAt: null },
    })
    if (changed.count !== 1) throw new Error("Persistent launch reservation changed concurrently")
    await tx.agentSandboxGeneration.upsert({
      where: { sandboxName },
      create: { sandboxName, conversationId, runId },
      update: { runId },
    })
    return true
  }))
}

/** Release only when provider calls have settled or when none could have been issued. */
export async function releasePersistentSandboxLaunch(prisma: AppPrismaClient, conversationId: string, token: string) {
  await withConflictRetry(() => prisma.agentSandboxOperation.updateMany({
    where: { conversationId, token, phase: { in: ["LAUNCH_PREPARED", "LAUNCHING"] } },
    data: { phase: "LAUNCH_SETTLED", retryAt: null },
  }))
  await withConflictRetry(() => prisma.agentSandboxOperation.deleteMany({ where: { conversationId, token, phase: "LAUNCH_SETTLED" } }))
}

/** Retire pre-dispatch reservations or completed launches left behind by a dead process. */
export async function recoverPersistentSandboxLaunches(prisma: AppPrismaClient, now: Date, limit: number) {
  const recoverable = {
    OR: [{ phase: "LAUNCH_SETTLED" }, { phase: "LAUNCH_PREPARED", retryAt: { lte: now } }],
  }
  const rows = await prisma.agentSandboxOperation.findMany({
    where: recoverable, take: limit, orderBy: { conversationId: "asc" },
    select: { conversationId: true, token: true },
  })
  for (const row of rows) {
    await withConflictRetry(() => prisma.agentSandboxOperation.deleteMany({ where: { ...row, ...recoverable } }))
  }
}

/**
 * Fresh work has its own bounded page, so even a full page of retrying failures
 * cannot starve it at the cron cadence. A retry page also runs during busy ticks.
 */
export async function findPersistentSandboxStopCandidates(
  prisma: AppPrismaClient,
  { now, idleBefore, limit, prefix }: { now: Date; idleBefore: Date; limit: number; prefix: string },
) {
  const runs = schemaTable("agent_runs")
  const operations = schemaTable("agent_sandbox_operations")
  const generations = schemaTable("agent_sandbox_generations")
  return prisma.$queryRaw<Candidate[]>`
    WITH eligible AS (
      SELECT r.id, r.conversation_id AS "conversationId", r.sandbox_name AS "sandboxName",
             r.created_at AS "createdAt", r.finished_at, op.token IS NULL AS fresh, op.retry_at
      FROM ${runs} r
      LEFT JOIN ${operations} op ON op.conversation_id = r.conversation_id
      LEFT JOIN ${generations} gen ON gen.sandbox_name = r.sandbox_name
      WHERE r.sandbox_name LIKE ${prefix + "%"}
        AND r.sandbox_stopped_at IS NULL
        AND r.finished_at IS NOT NULL
        AND (r.status IN ('FAILED', 'INTERRUPTED', 'CANCELED')
          OR (r.status = 'SUCCEEDED' AND r.finished_at <= ${idleBefore}))
        AND (op.token IS NULL OR (op.run_id = r.id AND op.phase IN ('RESERVED', 'RETRY', 'DISPATCHED', 'CONFIRMED')
          AND op.retry_at <= ${now}))
        AND NOT EXISTS (
          SELECT 1 FROM ${runs} active
          WHERE active.conversation_id = r.conversation_id AND active.status IN ('QUEUED', 'RUNNING')
        )
        AND (gen.run_id = r.id OR (gen.run_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM ${runs} newer
          WHERE newer.conversation_id = r.conversation_id AND newer.sandbox_name = r.sandbox_name
            AND (newer.created_at, newer.id) > (r.created_at, r.id)
        )))
    )
    (SELECT id, "conversationId", "sandboxName", "createdAt" FROM eligible WHERE fresh ORDER BY finished_at, id LIMIT ${limit})
    UNION ALL
    (SELECT id, "conversationId", "sandboxName", "createdAt" FROM eligible WHERE NOT fresh ORDER BY retry_at, id LIMIT ${Math.min(limit, 5)})
  `
}

export type PreparedPersistentSandboxStop = { sessionId: string; stop: () => Promise<void> }
/** Preparation only reads the provider. null means the sandbox has already stopped or never existed. */
export type PreparePersistentSandboxStop = (name: string) => Promise<PreparedPersistentSandboxStop | null>

export async function stopPersistentSandbox(
  prisma: AppPrismaClient,
  candidate: Candidate,
  now: Date,
  prepare: PreparePersistentSandboxStop,
  isQuiescent: (name: string, sessionId: string) => Promise<boolean>,
): Promise<boolean> {
  const { conversationId, id: runId, sandboxName, createdAt } = candidate
  const token = randomUUID()
  const retryAt = new Date(now.getTime() + RETRY_MS)
  const owner = await withConflictRetry(() => prisma.$transaction(async (tx) => {
    if (!(await lockSandboxConversation(tx, conversationId))) return null
    const operation = await tx.agentSandboxOperation.findUnique({ where: { conversationId } })
    if (operation?.runId === runId && ["CONFIRMED", "DISPATCHED"].includes(operation.phase) &&
      operation.retryAt && operation.retryAt <= now) return operation
    if (operation && (operation.runId !== runId || !["RESERVED", "RETRY"].includes(operation.phase) ||
      !operation.retryAt || operation.retryAt > now)) return null
    const current = await tx.agentRun.findUnique({ where: { id: runId }, select: { sandboxStoppedAt: true } })
    if (!current || current.sandboxStoppedAt) return null
    const generation = await tx.agentSandboxGeneration.findUnique({ where: { sandboxName }, select: { runId: true } })
    if (generation && generation.runId !== runId) return null
    const newerOrActive = await tx.agentRun.findFirst({
      where: {
        conversationId,
        id: { not: runId },
        OR: [
          { status: { in: IN_FLIGHT } },
          ...(!generation ? [
            { sandboxName, createdAt: { gt: createdAt } },
            { sandboxName, createdAt, id: { gt: runId } },
          ] : []),
        ],
      },
      select: { id: true },
    })
    if (newerOrActive) return null
    const data = { runId, sandboxName, token, phase: "RESERVED", retryAt }
    return operation
      ? tx.agentSandboxOperation.update({ where: { conversationId }, data })
      : tx.agentSandboxOperation.create({ data: { conversationId, ...data } })
  }))
  if (!owner) return false

  const claim = { conversationId, token: owner.token }
  if (owner.phase === "DISPATCHED") {
    // Reconcile the recorded immutable session. Never issue a fresh named stop
    // to recover a request that may already have taken effect.
    const polled = await withConflictRetry(() => prisma.agentSandboxOperation.updateMany({
      where: { ...claim, phase: "DISPATCHED", retryAt: owner.retryAt },
      data: { retryAt },
    }))
    if (polled.count !== 1 || !owner.providerSessionId || !(await isQuiescent(sandboxName, owner.providerSessionId))) return false
  } else if (owner.phase === "RESERVED") {
    let prepared: Awaited<ReturnType<PreparePersistentSandboxStop>>
    try {
      prepared = await prepare(sandboxName)
    } catch (error) {
      await withConflictRetry(() => prisma.agentSandboxOperation.updateMany({
        where: { ...claim, phase: "RESERVED" },
        data: { phase: "RETRY", retryAt },
      }))
      throw error
    }
    const { count } = await withConflictRetry(() => prisma.agentSandboxOperation.updateMany({
      where: { ...claim, phase: "RESERVED" },
      data: prepared
        ? { phase: "DISPATCHED", providerSessionId: prepared.sessionId, retryAt }
        : { phase: "CONFIRMED", retryAt: now },
    }))
    if (count !== 1) return false
    if (prepared) await prepared.stop()
  }
  if (owner.phase !== "CONFIRMED") {
    await withConflictRetry(() => prisma.agentSandboxOperation.updateMany({
      where: { ...claim, phase: "DISPATCHED" },
      data: { phase: "CONFIRMED", retryAt: now },
    }))
  }

  try {
    return await withConflictRetry(() => prisma.$transaction(async (tx) => {
      const released = await tx.agentSandboxOperation.deleteMany({ where: { ...claim, phase: "CONFIRMED" } })
      if (released.count !== 1) return false
      await tx.agentRun.updateMany({
        where: { id: runId, conversationId, sandboxName, sandboxStoppedAt: null },
        data: { sandboxStoppedAt: now, updatedAt: now },
      })
      return true
    }))
  } catch (error) {
    await withConflictRetry(() => prisma.agentSandboxOperation.updateMany({
      where: { ...claim, phase: "CONFIRMED" },
      data: { retryAt },
    }))
    throw error
  }
}

export const PERSISTENT_SANDBOX_LOOKUP_FAILED = "PersistentSandboxLookupFailed"
