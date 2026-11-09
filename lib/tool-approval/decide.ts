import getPrisma from "@/lib/db"
import { recordDecision } from "@/lib/decision-service"
import { ToolApprovalError } from "@/lib/tool-approval/errors"
import { EXECUTE_TOOL_APPROVAL_CONTINUATION, TOOL_APPROVAL_DECISION_CHANNEL, TOOL_APPROVAL_GATE } from "@/lib/tool-approval/gate"
import { executeApprovedToolCall, type ExecuteOutcome } from "@/lib/tool-approval/executor"

/**
 * The ONLY way to decide a TOOL_APPROVAL request. Records the human admin's decision through recordDecision (which enforces
 * HUMAN_ACTOR_REQUIRED, membership, ADMIN, freshness, expiry and idempotency) and, for an approval, immediately hands the
 * decision id to the executor. The approval page (A3) only needs to call this. Replaying the same idempotencyKey is safe: the
 * executor's receipt makes the second call report ALREADY_APPLIED.
 */
export async function decideToolApproval(input: {
  requestId: string
  optionActionKey: "APPROVE" | "REJECT"
  actingUserId: string
  idempotencyKey: string
}) {
  const request = await getPrisma().reviewRequest.findFirst({
    where: { id: input.requestId, gateType: TOOL_APPROVAL_GATE },
    include: { currentRevision: { include: { options: true } } },
  })
  const revision = request?.currentRevision
  if (!request || !revision) throw new ToolApprovalError("REQUEST_NOT_FOUND", "Approval request not found.")
  const option = revision.options.find((candidate) => candidate.actionKey === input.optionActionKey)
  if (!option) throw new ToolApprovalError("OPTION_NOT_FOUND", "That option is not part of this approval.")

  const decision = await recordDecision({
    actor: { kind: "USER", userId: input.actingUserId },
    revisionId: revision.id,
    fingerprint: revision.fingerprint,
    optionId: option.id,
    idempotencyKey: input.idempotencyKey,
    toolApprovalChannel: TOOL_APPROVAL_DECISION_CHANNEL,
  })
  const approves = option.outcomeClass === "APPROVE" && option.continuationKey === EXECUTE_TOOL_APPROVAL_CONTINUATION
  const execution: ExecuteOutcome | null = approves ? await executeApprovedToolCall(decision.id) : null
  return { decision, execution }
}
