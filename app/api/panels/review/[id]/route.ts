import { NextResponse } from "next/server"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { isEntityId } from "@/lib/entity-links"
import { canDecideReview, isOrgAdminRole } from "@/lib/roles"
import { isChoiceActionKey, parseDecisionAnswers, parsePacketQuestions } from "@/lib/tracked-decision-types"
import { parseTrackedDecisionPacket } from "@/components/decisions/decision-sources"

/**
 * Detail-panel data source for a decision request. GET
 *   /api/panels/review/<uuid>?orgSlug=<>&workspaceSlug=<>
 * Same two-layer rule as /api/panels/entity: a session, plus membership of the named workspace (or org admin),
 * then a lookup scoped to that workspace — a foreign or missing request is the same 404.
 * Decisions are addressed by UUID only, so this sits beside the entity route rather than in it.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const orgSlug = searchParams.get("orgSlug")
  const workspaceSlug = searchParams.get("workspaceSlug")
  if (!orgSlug || !workspaceSlug) return NextResponse.json({ error: "orgSlug and workspaceSlug are required" }, { status: 400 })
  if (!isEntityId(id)) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const request = await getPrisma().reviewRequest.findFirst({
    where: { id, workspace: { slug: workspaceSlug, organization: { slug: orgSlug } } },
    include: {
      currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: { include: { option: true } } } },
      workspace: { select: { members: { where: { userId: session.user.id }, select: { role: true } }, organization: { select: { members: { where: { userId: session.user.id }, select: { role: true } } } } } },
    },
  })
  const memberRole = request?.workspace.members[0]?.role
  const orgRole = request?.workspace.organization.members[0]?.role
  if (!request?.currentRevision || (!memberRole && !isOrgAdminRole(orgRole))) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const revision = request.currentRevision
  const decided = revision.decisions[0]
  const isTracked = request.gateType === "TRACKED_DECISION"
  const tracked = isTracked ? parseTrackedDecisionPacket(revision.packetJson) : null
  const retired = ["NOW_COMMITMENT", "NOW_POLICY_ACTIVATION", "BUILDING_INVESTMENT", "BUILDING_INVESTMENT_REVOCATION"].includes(request.gateType)

  return NextResponse.json({
    data: {
      id: request.id,
      workspaceId: request.workspaceId,
      state: request.state,
      isTracked,
      readOnlyLegacy: retired && !decided,
      stale: Boolean(revision.supersededAt),
      title: revision.title,
      summary: isTracked ? null : revision.summary,
      context: tracked?.context ?? (isTracked ? revision.summary : null),
      linkedTo: tracked?.entity ? { type: tracked.entity.type, title: tracked.entity.title } : null,
      revisionId: revision.id,
      fingerprint: revision.fingerprint,
      canDecide: isTracked && canDecideReview(memberRole, orgRole),
      options: revision.options.map((o) => ({ id: o.id, label: o.label, outcomeClass: o.outcomeClass, actionKey: o.actionKey ?? undefined, description: o.description })),
      offeredChoices: revision.options.filter((o) => isChoiceActionKey(o.actionKey)).map((o) => ({ id: o.id, label: o.label, description: o.description })),
      questions: isTracked ? parsePacketQuestions(revision.packetJson) : [],
      decision: decided
        ? {
            label: decided.option.label,
            description: decided.option.description,
            outcomeClass: decided.option.outcomeClass,
            actorRole: decided.actorRole,
            decidedAt: decided.decidedAt.toISOString(),
            rationale: decided.rationale,
            answers: parseDecisionAnswers(decided.answersJson),
          }
        : null,
    },
  })
}
