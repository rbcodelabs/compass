import getPrisma from "@/lib/db"
import { getMcpActor } from "@/lib/mcp-authz"
import { ok, fail } from "@/lib/mcp-output"
import { admitRoadmapItemToNow, prepareNowCommitment } from "@/lib/now-commitment"

export async function requestNowCommitment({ itemId }: { itemId: string }) {
  const actor = getMcpActor()
  try {
    const revision = await prepareNowCommitment(itemId, { requestedById: actor.userId })
    return ok(`NOW commitment review prepared.\nID: ${revision.requestId}\nRevision ID: ${revision.id}\nFingerprint: ${revision.fingerprint}`, revision)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not prepare NOW commitment review.")
  }
}

export async function getReviewRequest({ requestId }: { requestId: string }) {
  const request = await getPrisma().reviewRequest.findUnique({
    where: { id: requestId },
    include: { currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: true } } },
  })
  if (!request) return fail(`Review request "${requestId}" not found.`)
  return ok(`Review request ${request.id} [${request.state}]\nGate: ${request.gateType}\nSubject: ${request.subjectType} ${request.subjectId}`, request)
}

export async function listReviewRequests({ workspaceId, state }: { workspaceId: string; state?: string }) {
  const requests = await getPrisma().reviewRequest.findMany({
    where: { workspaceId, ...(state ? { state } : {}) },
    include: { currentRevision: { select: { title: true, fingerprint: true } } },
    orderBy: { updatedAt: "desc" },
  })
  return ok(requests.length ? requests.map((request) => `• ${request.currentRevision?.title ?? request.subjectId} [${request.state}] (${request.id})`).join("\n") : "No review requests found.", { requests })
}

export async function applyRecordedDecision({ decisionId }: { decisionId: string }) {
  const prisma = getPrisma()
  const decision = await prisma.decisionRecord.findUnique({ where: { id: decisionId }, include: { revision: { include: { request: true } } } })
  if (!decision) return fail(`Decision "${decisionId}" not found.`)
  if (decision.revision.request.gateType !== "NOW_COMMITMENT") {
    return fail("This decision gate does not yet have an MCP applicator. RELEASE_AUTHORIZATION remains owned by the ADR-0004 release lifecycle.")
  }
  try {
    const receipt = await admitRoadmapItemToNow(decision.revision.request.subjectId, decision.id)
    return ok(`Decision applied.\nID: ${receipt.id}\nReceipt: ${receipt.receiptKey}\nStatus: ${receipt.status}`, receipt)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not apply decision.")
  }
}
