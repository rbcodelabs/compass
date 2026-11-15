import getPrisma from "@/lib/db"
import { displayIdFromRow } from "@/lib/work-item-ids"

export { decisionStatusBadgeProps, plainTextPreview, type DecisionBadgeTone } from "@/lib/decision-review-ui"

export async function resolveDeciderName(
  decided: { actorUserId?: string | null; actorRole: string } | null | undefined,
): Promise<string | null> {
  if (!decided) return null
  const prisma = getPrisma()
  if (decided.actorUserId && prisma.user?.findUnique) {
    const user = await prisma.user.findUnique({
      where: { id: decided.actorUserId },
      select: { name: true, email: true },
    })
    if (user) return user.name?.trim() || user.email
  }
  return decided.actorRole
}

export type PendingQueueContext = {
  /** 1-based index of the current request in the pending queue, or null when current request is already decided. */
  position: number | null
  total: number
  prevRef: string | null
  nextRef: string | null
}

/**
 * Loads the ordered pending TRACKED_DECISION queue for Inbox Triage Prev / Next navigation.
 * Matches `/decisions?tab=pending` ordering (`updatedAt: "desc"`). Tolerates partial unit-test Prisma mocks.
 */
export async function loadPendingQueueNeighbors(
  workspaceId: string,
  currentRequestId: string,
): Promise<PendingQueueContext> {
  const prisma = getPrisma()
  if (!prisma.reviewRequest?.findMany) {
    return { position: null, total: 0, prevRef: null, nextRef: null }
  }
  const rows = await prisma.reviewRequest.findMany({
    where: { workspaceId, gateType: "TRACKED_DECISION", state: "PENDING" },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    select: { id: true, seqPrefix: true, seqNumber: true },
    take: 200,
  })
  if (!Array.isArray(rows) || rows.length === 0) {
    return { position: null, total: 0, prevRef: null, nextRef: null }
  }
  const toRef = (row: { id: string; seqPrefix?: string | null; seqNumber?: number | null }) =>
    displayIdFromRow("reviewRequest", row) ?? row.id
  const index = rows.findIndex((row) => row.id === currentRequestId)
  if (index === -1) {
    return {
      position: null,
      total: rows.length,
      prevRef: null,
      nextRef: toRef(rows[0]),
    }
  }
  return {
    position: index + 1,
    total: rows.length,
    prevRef: index > 0 ? toRef(rows[index - 1]) : null,
    nextRef: index + 1 < rows.length ? toRef(rows[index + 1]) : null,
  }
}
