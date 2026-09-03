import { createHash } from "node:crypto"

export type NativeDecisionEvidence = {
  id: string
  workspaceId: string
  revisionId: string
  requestId?: string
  optionId: string
  fingerprint: string
  decidedAt: Date
  revision: { fingerprint: string; supersededAt: Date | null; request: { id: string; gateType: string; subjectType: string; subjectId: string; workspaceId: string }; options?: Array<{ id: string }> }
  request?: { id: string; state: string; currentRevisionId: string | null }
  option: { outcomeClass: string; continuationKey: string }
  applications: Array<{ id: string; status: string; continuationKey: string; targetType: string; targetId: string }>
}

export function investmentAuthorityChecksum(evidence: NativeDecisionEvidence, applicationId: string): string {
  return createHash("sha256").update(JSON.stringify({
    authority: "COMPASS_NATIVE",
    decisionId: evidence.id,
    workspaceId: evidence.workspaceId,
    solutionId: evidence.revision.request.subjectId,
    revisionId: evidence.revisionId,
    optionId: evidence.optionId,
    fingerprint: evidence.fingerprint,
    decidedAt: evidence.decidedAt.toISOString(),
    applicationId,
    continuationKey: "AUTHORIZE_BUILDING_INVESTMENT",
  })).digest("hex")
}
