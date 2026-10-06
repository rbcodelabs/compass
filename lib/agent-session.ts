/**
 * Durable Agent SDK sessions for the in-app agent.
 *
 * Until this existed, every turn booted a fresh sandbox and rebuilt a *text* prompt
 * from the last 20 chat messages: no tool results, no reasoning, no compaction. The
 * SDK can resume a real session instead, but its transcript lives on the sandbox's
 * local disk, and the sandbox is disposable. So the transcript is carried between
 * turns through a private Vercel Blob object, with a one-row-per-conversation pointer
 * (`agent_sessions`) saying which object is current.
 *
 * Everything here is an optimization over the text replay, never a requirement for it.
 * Each entry point degrades to "no session" (the old prompt) when the table is not yet
 * migrated, Blob is not configured, the object is missing or oversized, or a step
 * throws. A turn must never fail because its session could not be loaded or saved.
 *
 * Tenant isolation: the Blob key and the pointer row are derived server-side from the
 * conversation/workspace ids the run row already holds. The sandbox supplies bytes and
 * a session id, never a path, so it cannot name another conversation's object.
 */

import { randomUUID } from "node:crypto"
import type { AppPrismaClient } from "@/lib/db"
import { getAgentSessionStorage, type ArtifactStorage } from "@/lib/artifact-storage"

/**
 * Compressed transcript ceiling. Vercel Functions cap a request body at 4.5 MB and the
 * sandbox uploads through one, so 4 MB leaves headroom for framing. A conversation
 * whose transcript outgrows this stops advancing its session and falls back to text
 * replay for the turns it has not covered (see MAX_GAP_MESSAGES).
 */
export const MAX_AGENT_SESSION_BYTES = 4_000_000

/** If more than this many messages postdate the session, replay text instead. */
export const MAX_GAP_MESSAGES = 40

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export const isSessionUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value)

let availabilityCache: { value: boolean; checkedAt: number } | null = null
const NEGATIVE_TTL_MS = 30_000

/**
 * Whether `080_agent_sessions` has been applied. Prisma reports a missing table as
 * P2021; anything else is a real fault and is rethrown. Positive results are cached
 * for the life of the process; a negative one re-probes after 30s so applying the
 * migration takes effect without a redeploy.
 */
export async function agentSessionsAvailable(prisma: AppPrismaClient): Promise<boolean> {
  if (availabilityCache?.value) return true
  if (availabilityCache && Date.now() - availabilityCache.checkedAt < NEGATIVE_TTL_MS) return false
  try {
    await prisma.agentSession.findFirst({ select: { conversationId: true } })
    availabilityCache = { value: true, checkedAt: Date.now() }
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2021") {
      availabilityCache = { value: false, checkedAt: Date.now() }
      return false
    }
    throw error
  }
}

/** Test seam. */
export function resetAgentSessionsAvailabilityCache() {
  availabilityCache = null
}

export function agentSessionBlobKey(workspaceId: string, conversationId: string): string {
  if (!isSessionUuid(workspaceId) || !isSessionUuid(conversationId)) throw new Error("Invalid agent session scope")
  // A fresh object per revision: the pointer swap is the commit, so a half-written or
  // losing upload can never be observed under the key a reader is following.
  return `agent-sessions/${workspaceId}/${conversationId}/${randomUUID()}.jsonl.gz`
}

/** True for a gzip stream of a plausible size. Content is validated by the sandbox on load. */
export function looksLikeSessionBlob(bytes: Uint8Array): boolean {
  return bytes.byteLength > 18 && bytes.byteLength <= MAX_AGENT_SESSION_BYTES && bytes[0] === 0x1f && bytes[1] === 0x8b
}

type Turn = { role: string; content: string }

export type AgentSessionPlan =
  | { enabled: false }
  | { enabled: true; sessionId: string; resume: null }
  | { enabled: true; sessionId: string; resume: { bytes: Uint8Array; gap: Turn[] } }

const log = (message: string, detail?: unknown) => console.warn(`[agent-session] ${message}`, detail ?? "")

/**
 * Decide how this turn should run: resume the stored session (with the messages it has
 * not seen), start a fresh session that will be stored at the end, or no session at all.
 *
 * `currentMessageId` is the user message this turn is answering. It is excluded from the
 * gap because the prompt carries it already.
 */
export async function planAgentSession({
  prisma,
  conversationId,
  workspaceId,
  currentMessageId,
  storage,
}: {
  prisma: AppPrismaClient
  conversationId: string
  workspaceId: string
  currentMessageId: string
  storage?: () => ArtifactStorage
}): Promise<AgentSessionPlan> {
  try {
    if (!(await agentSessionsAvailable(prisma))) return { enabled: false }
    const getStorage = storage ?? getAgentSessionStorage
    // Throws when Blob is not configured, which disables sessions rather than the turn.
    const blobs = getStorage()

    const pointer = await prisma.agentSession.findUnique({ where: { conversationId } })
    const fresh: AgentSessionPlan = { enabled: true, sessionId: randomUUID(), resume: null }
    if (!pointer || pointer.workspaceId !== workspaceId) return fresh

    const through = await prisma.agentMessage.findFirst({
      where: { id: pointer.throughMessageId, conversationId },
      select: { id: true, createdAt: true },
    })
    if (!through) return fresh

    const later = await prisma.agentMessage.findMany({
      where: { conversationId, createdAt: { gte: through.createdAt } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_GAP_MESSAGES + 4,
      select: { id: true, role: true, content: true },
    })
    const afterThrough = later.filter((m) => m.id !== through.id && m.id !== currentMessageId)
    // The session already holds the assistant reply to its own turn; that reply is
    // persisted after the transcript was committed, so it is the first row after it.
    const gapRows = afterThrough[0]?.role === "assistant" ? afterThrough.slice(1) : afterThrough
    if (gapRows.length > MAX_GAP_MESSAGES) return fresh

    const bytes = await blobs.get(pointer.blobKey)
    if (!bytes || !looksLikeSessionBlob(bytes)) return fresh
    return {
      enabled: true,
      sessionId: pointer.sessionId,
      resume: { bytes, gap: gapRows.map((m) => ({ role: m.role, content: m.content })) },
    }
  } catch (error) {
    log("could not plan a session; using the text prompt", error)
    return { enabled: false }
  }
}

/**
 * The prompt for a resumed turn. The session already holds the workspace framing and
 * everything it saw, so only what happened *outside* it needs restating.
 */
export function buildResumePrompt(gap: Turn[], userMessage: string): string {
  const missed = gap.length
    ? `Messages exchanged in this conversation since your last turn (you did not see them):\n` +
      gap.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`).join("\n")
    : ""
  return [missed, `User: ${userMessage}`, "Assistant:"].filter(Boolean).join("\n\n")
}

/**
 * The user message a run was answering: the latest one at or before the run row was
 * created (the route persists it immediately before creating the run).
 */
export async function findRunUserMessageId(prisma: AppPrismaClient, conversationId: string, runCreatedAt: Date) {
  const row = await prisma.agentMessage.findFirst({
    where: { conversationId, role: "user", createdAt: { lte: runCreatedAt } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  })
  return row?.id ?? null
}

export type CommitResult = { committed: boolean; reason?: "STALE" | "INVALID"; revision?: number }

/**
 * Store a finished transcript and point the conversation at it. The new object is written
 * first under a fresh key; the pointer then moves with a compare-and-set on `revision`,
 * and only the losing/previous object is deleted. A crash between the two leaves an
 * orphaned object, never a pointer to a missing one.
 *
 * Monotonic: a commit whose turn is older than the stored session's loses, so two
 * overlapping turns (the synchronous path has no run lock) cannot roll it backwards.
 */
export async function commitAgentSession({
  prisma,
  conversationId,
  workspaceId,
  sessionId,
  throughMessageId,
  bytes,
  storage,
}: {
  prisma: AppPrismaClient
  conversationId: string
  workspaceId: string
  sessionId: string
  throughMessageId: string
  bytes: Uint8Array
  storage?: () => ArtifactStorage
}): Promise<CommitResult> {
  if (!isSessionUuid(sessionId) || !looksLikeSessionBlob(bytes)) return { committed: false, reason: "INVALID" }
  const blobs = (storage ?? getAgentSessionStorage)()

  const through = await prisma.agentMessage.findFirst({
    where: { id: throughMessageId, conversationId },
    select: { createdAt: true },
  })
  if (!through) return { committed: false, reason: "INVALID" }

  const blobKey = agentSessionBlobKey(workspaceId, conversationId)
  await blobs.put(blobKey, bytes, "application/gzip")
  const discard = () => blobs.del(blobKey).catch((error) => log("could not delete an unused transcript", error))

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await prisma.agentSession.findUnique({ where: { conversationId } })
      const now = new Date()
      if (!existing) {
        try {
          await prisma.agentSession.create({
            data: {
              conversationId,
              workspaceId,
              sessionId,
              blobKey,
              throughMessageId,
              revision: 1,
              byteSize: bytes.byteLength,
              createdAt: now,
              updatedAt: now,
            },
          })
          return { committed: true, revision: 1 }
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") continue
          throw error
        }
      }
      if (existing.workspaceId !== workspaceId) {
        await discard()
        return { committed: false, reason: "INVALID" }
      }
      const existingThrough = await prisma.agentMessage.findFirst({
        where: { id: existing.throughMessageId, conversationId },
        select: { createdAt: true },
      })
      if (existingThrough && existingThrough.createdAt.getTime() > through.createdAt.getTime()) {
        await discard()
        return { committed: false, reason: "STALE" }
      }
      const swapped = await prisma.agentSession.updateMany({
        where: { conversationId, revision: existing.revision },
        data: {
          sessionId,
          blobKey,
          throughMessageId,
          revision: existing.revision + 1,
          byteSize: bytes.byteLength,
          updatedAt: now,
        },
      })
      if (swapped.count === 1) {
        if (existing.blobKey !== blobKey) await blobs.del(existing.blobKey).catch((error) => log("could not delete the previous transcript", error))
        return { committed: true, revision: existing.revision + 1 }
      }
    }
    await discard()
    return { committed: false, reason: "STALE" }
  } catch (error) {
    await discard()
    throw error
  }
}

/** Remove every stored session for a workspace: objects first, then pointer rows. */
export async function deleteWorkspaceAgentSessions(prisma: AppPrismaClient, workspaceId: string, storage?: () => ArtifactStorage) {
  if (!(await agentSessionsAvailable(prisma))) return
  const rows = await prisma.agentSession.findMany({ where: { workspaceId }, select: { blobKey: true } })
  if (rows.length) {
    try {
      const blobs = (storage ?? getAgentSessionStorage)()
      await Promise.all(rows.map((row) => blobs.del(row.blobKey).catch((error) => log("could not delete a transcript", error))))
    } catch (error) {
      // Blob not configured: nothing could have been stored there either.
      log("skipping transcript deletion", error)
    }
  }
  await prisma.agentSession.deleteMany({ where: { workspaceId } })
}
