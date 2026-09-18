/**
 * Centralized per-tool authorization policy for the MCP catalog.
 *
 * Every MCP tool maps to exactly one gate here. `withMcpAuth` establishes the
 * acting identity (McpActor) via AsyncLocalStorage, and the `register()`
 * wrapper in app/api/mcp/route.ts runs the tool's gate BEFORE its handler.
 *
 * FAIL-CLOSED BY CONSTRUCTION: `applyToolGate` throws for any tool without an
 * entry here, so a newly-added tool is DENIED until a policy is written for it.
 * A completeness test (__tests__/mcp-tool-gates.test.ts) asserts every
 * registered tool name has an entry, catching this at build time too.
 *
 * Gate semantics (see lib/mcp-authz.ts):
 *   - service key (purpose === SERVICE) → every assert is a no-op (global/trusted).
 *   - per-user key → membership/role-scoped to the acting user.
 *
 * `args` are already validated against the tool's zod inputSchema by the SDK
 * before the gate runs, so field types are trusted here.
 */

import {
  type McpActor,
  McpAuthzError,
  type WorkspaceEntityType,
  isServiceActor,
  isResearchActor,
  assertWorkspaceMember,
  assertWorkspaceAdmin,
  assertWorkspaceBySlug,
  assertOrgMemberBySlug,
  assertOrgAdminBySlug,
  assertEntityAccess,
  assertScoringModelAccess,
} from "@/lib/mcp-authz"
import { SCOPE_MCP_READ, SCOPE_MCP_WRITE } from "@/lib/oauth/constants"
import { gateInterviewTool } from "@/lib/pm-agent-service"
import { CUSTOM_FIELD_ENTITY } from "@/lib/custom-field-tool-handlers"
import type { CustomFieldObjectType } from "@/lib/types"
import { assertLaunchWorkflowEnabled } from "@/lib/launch-checklist"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any> // runtime-validated by each tool's zod inputSchema
type Gate = (actor: McpActor, args: Args) => Promise<void>

export const RESEARCH_TOOL_ALLOWLIST = new Set<string>()

// ── Polymorphic target maps (values are WorkspaceEntityType) ────────────────

const ASSIGN_SQUAD_ENTITY: Record<string, WorkspaceEntityType> = {
  opportunity: "opportunity",
  experiment: "experiment",
  roadmap_item: "roadmapItem",
  objective: "objective",
  task: "task",
}

// Mirrors LINK_TARGET_MODEL in lib/task-tool-handlers.ts, plus DECISION
// (ReviewRequest), which that map deliberately excludes (see its comment)
// but which is still a valid link_task/unlink_task target needing a gate.
const TASK_LINK_ENTITY: Record<string, WorkspaceEntityType> = {
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ROADMAP_ITEM: "roadmapItem",
  OBJECTIVE: "objective",
  KEY_RESULT: "keyResult",
  DOC: "doc",
  EXPERIMENT: "experiment",
  FEEDBACK_ITEM: "feedbackItem",
  DECISION: "reviewRequest",
}

const DECISION_SUBJECT_ENTITY: Record<string, WorkspaceEntityType> = {
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ROADMAP_ITEM: "roadmapItem",
  DOC: "doc",
  EXPERIMENT: "experiment",
  FEEDBACK: "feedbackItem",
}

const COMMENT_TARGET_ENTITY: Record<string, WorkspaceEntityType> = {
  OBJECTIVE: "objective", KEY_RESULT: "keyResult", OPPORTUNITY: "opportunity", SOLUTION: "solution",
  ASSUMPTION: "assumption", EXPERIMENT: "experiment", ROADMAP_ITEM: "roadmapItem",
  FEEDBACK_ITEM: "feedbackItem", TASK: "task", DOC: "doc", ARTIFACT: "artifact",
  RESEARCH_STUDY: "researchStudy", REVIEW_REQUEST: "reviewRequest",
}

/** The declared objectType resolves to one of the 7 already-gated WorkspaceEntityTypes. */
async function assertCustomFieldObjectAccess(actor: McpActor, args: Args) {
  const entity = CUSTOM_FIELD_ENTITY[args.objectType as CustomFieldObjectType]
  if (!entity) throw new McpAuthzError(`Unknown objectType: ${args.objectType}`)
  await assertEntityAccess(actor, entity, args.objectId)
}

async function assertCommentTarget(actor: McpActor, args: Args) {
  const entity = COMMENT_TARGET_ENTITY[args.targetType]
  if (!entity) throw new McpAuthzError(`Unknown comment targetType: ${args.targetType}`)
  const { workspaceId } = await assertEntityAccess(actor, entity, args.targetId)
  if (workspaceId !== args.workspaceId) throw new McpAuthzError("Comment target does not belong to the declared workspace.")
  await assertWorkspaceMember(actor, args.workspaceId)
}

// ── Shared cross-checks (landmine tools) ────────────────────────────────────

/** The provided evidence target (exactly one of opp/sol/assumption); returns its workspaceId. */
async function assertEvidenceTarget(actor: McpActor, args: Args): Promise<string> {
  if (args.opportunityId) return (await assertEntityAccess(actor, "opportunity", args.opportunityId)).workspaceId
  if (args.solutionId) return (await assertEntityAccess(actor, "solution", args.solutionId)).workspaceId
  if (args.assumptionId) return (await assertEntityAccess(actor, "assumption", args.assumptionId)).workspaceId
  throw new McpAuthzError("An evidence target (opportunityId, solutionId, or assumptionId) is required.")
}

/**
 * A caller-supplied workspaceId must match the workspace the child entity
 * actually belongs to — otherwise a member of workspace B could write a row
 * pointing at an entity in workspace A. Asserts membership of both.
 */
async function assertChildInDeclaredWorkspace(
  actor: McpActor,
  entityType: WorkspaceEntityType,
  entityId: string,
  declaredWorkspaceId: string
): Promise<void> {
  const { workspaceId } = await assertEntityAccess(actor, entityType, entityId)
  if (workspaceId !== declaredWorkspaceId) {
    throw new McpAuthzError(`${entityType} does not belong to workspace ${declaredWorkspaceId}.`)
  }
  await assertWorkspaceMember(actor, declaredWorkspaceId)
}

// ── The policy: every MCP tool → its gate ───────────────────────────────────

export const TOOL_GATES: Record<string, Gate> = {
  get_pm_interview: async () => {},
  update_experiment: async (a, x) => void (await assertEntityAccess(a, "experiment", x.experimentId)),
  get_current_identity: async () => {},
  list_task_assignees: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  generate_research_guide: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  create_research_study: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  list_research_studies: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_research_study: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  update_research_study: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  activate_research_study: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  close_research_study: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  archive_research_study: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  issue_research_link: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  rotate_research_link: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  revoke_research_links: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  // Transcript reads are study-scoped exactly like the tools above; the session
  // is then resolved inside that study by the service, so sessionId alone can
  // never reach another study's turns.
  list_research_sessions: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  get_research_session: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  // Synthesis history and storage are study-scoped on exactly the same terms.
  list_research_syntheses: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  generate_research_synthesis: (a, x) => assertChildInDeclaredWorkspace(a, "researchStudy", x.studyId, x.workspaceId),
  // ADR-0012 step 5. Deliberately the SAME gate as add_evidence, because the ADR
  // is explicit that promotion "is subject to the same authorization as any other
  // mutation the user could perform". The synthesis itself is not gated here:
  // assertEntityAccess has no researchSynthesis entity, and the promotion service
  // pins the cited synthesis to this workspace and refuses a PM-interview study
  // before reading anything (lib/research-evidence-promotion.ts).
  //
  // What keeps ADR-0002 invariant 6 intact is NOT this entry. It is the absence
  // of this tool from RESEARCH_SYNTHESIS_TOOLS (lib/research-handoff-scope.ts),
  // enforced by gateInterviewTool, which runs first inside applyToolGate below.
  promote_research_finding_to_evidence: async (a, x) => {
    await assertWorkspaceMember(a, x.workspaceId)
    const targetWs = await assertEvidenceTarget(a, x)
    if (targetWs !== x.workspaceId) {
      throw new McpAuthzError("Evidence target does not belong to the declared workspace.")
    }
  },
  add_comment: assertCommentTarget,
  list_comments: assertCommentTarget,
  get_comment: async (a, x) => void (await assertEntityAccess(a, "comment", x.commentId)),
  update_comment: async (a, x) => void (await assertEntityAccess(a, "comment", x.commentId)),
  delete_comment: async (a, x) => void (await assertEntityAccess(a, "comment", x.commentId)),
  resolve_comment: async (a, x) => void (await assertEntityAccess(a, "comment", x.commentId)),
  reopen_comment: async (a, x) => void (await assertEntityAccess(a, "comment", x.commentId)),
  // Workspace ---------------------------------------------------------------
  get_workspace_summary: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  // list_workspaces additionally filters its results to the caller's
  // memberships in the handler; org membership is the gate.
  list_workspaces: async (a, x) => void (await assertOrgMemberBySlug(a, x.orgSlug)),
  get_workspace_by_slug: async (a, x) => void (await assertWorkspaceBySlug(a, x.orgSlug, x.workspaceSlug)),
  create_workspace: async (a, x) => void (await assertOrgAdminBySlug(a, x.orgSlug)),

  // OKRs --------------------------------------------------------------------
  list_okr_cycles: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  create_okr_cycle: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_okr_cycle: async (a, x) => void (await assertEntityAccess(a, "okrCycle", x.cycleId)),
  create_objective: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  update_objective: async (a, x) => void (await assertEntityAccess(a, "objective", x.objectiveId)),
  delete_objective: async (a, x) => void (await assertEntityAccess(a, "objective", x.objectiveId)),
  add_key_result: async (a, x) => void (await assertEntityAccess(a, "objective", x.objectiveId)),
  update_key_result: async (a, x) => void (await assertEntityAccess(a, "keyResult", x.keyResultId)),
  delete_key_result: async (a, x) => void (await assertEntityAccess(a, "keyResult", x.keyResultId)),
  log_checkin: async (a, x) => void (await assertEntityAccess(a, "keyResult", x.keyResultId)),
  set_objective_parent_kr: async (a, x) => {
    await assertEntityAccess(a, "objective", x.objectiveId)
    if (x.keyResultId) await assertEntityAccess(a, "keyResult", x.keyResultId)
  },
  list_eligible_parent_key_results: (a, x) => assertChildInDeclaredWorkspace(a, "okrCycle", x.cycleId, x.workspaceId),

  // Discovery ---------------------------------------------------------------
  list_opportunities: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  list_solutions: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  list_assumptions: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_opportunity: async (a, x) => void (await assertEntityAccess(a, "opportunity", x.opportunityId)),
  create_opportunity: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  update_opportunity: async (a, x) => void (await assertEntityAccess(a, "opportunity", x.opportunityId)),
  update_opportunity_status: async (a, x) => void (await assertEntityAccess(a, "opportunity", x.opportunityId)),
  link_opportunity_to_kr: async (a, x) => {
    await assertEntityAccess(a, "opportunity", x.opportunityId)
    if (x.keyResultId) await assertEntityAccess(a, "keyResult", x.keyResultId)
  },
  add_solution: async (a, x) => void (await assertEntityAccess(a, "opportunity", x.opportunityId)),
  update_solution_status: async (a, x) => void (await assertEntityAccess(a, "solution", x.solutionId)),
  update_solution: async (a, x) => void (await assertEntityAccess(a, "solution", x.solutionId)),
  add_assumption: async (a, x) => void (await assertEntityAccess(a, "solution", x.solutionId)),
  update_assumption: async (a, x) => void (await assertEntityAccess(a, "assumption", x.assumptionId)),
  delete_assumption: async (a, x) => void (await assertEntityAccess(a, "assumption", x.assumptionId)),
  promote_to_roadmap: (a, x) => assertChildInDeclaredWorkspace(a, "solution", x.solutionId, x.workspaceId),

  // Solution plans / comments ----------------------------------------------
  add_solution_plan: async (a, x) => void (await assertEntityAccess(a, "solution", x.solutionId)),
  add_solution_comment: async (a, x) => void (await assertEntityAccess(a, "solution", x.solutionId)),
  list_solution_comments: async (a, x) => void (await assertEntityAccess(a, "solution", x.solutionId)),
  get_solution_comment: async (a, x) => void (await assertEntityAccess(a, "solutionComment", x.commentId)),
  update_solution_comment: async (a, x) => void (await assertEntityAccess(a, "solutionComment", x.commentId)),
  delete_solution_comment: async (a, x) => void (await assertEntityAccess(a, "solutionComment", x.commentId)),
  approve_solution_plan: async (a, x) => void (await assertEntityAccess(a, "solutionComment", x.commentId)),
  reject_solution_plan: async (a, x) => void (await assertEntityAccess(a, "solutionComment", x.commentId)),

  // Experiments -------------------------------------------------------------
  list_experiments: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_experiment: async (a, x) => void (await assertEntityAccess(a, "experiment", x.experimentId)),
  create_experiment: async (a, x) => {
    await assertWorkspaceMember(a, x.workspaceId)
    if (x.assumptionId) await assertChildInDeclaredWorkspace(a, "assumption", x.assumptionId, x.workspaceId)
  },
  log_experiment_result: async (a, x) => void (await assertEntityAccess(a, "experiment", x.experimentId)),
  conclude_experiment: async (a, x) => void (await assertEntityAccess(a, "experiment", x.experimentId)),

  // Roadmap -----------------------------------------------------------------
  list_roadmap_items: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  update_roadmap_item: async (a, x) => void (await assertEntityAccess(a, "roadmapItem", x.itemId)),
  add_to_roadmap: async (a, x) => {
    await assertWorkspaceMember(a, x.workspaceId)
    if (x.solutionId) await assertChildInDeclaredWorkspace(a, "solution", x.solutionId, x.workspaceId)
    if (x.opportunityId) await assertChildInDeclaredWorkspace(a, "opportunity", x.opportunityId, x.workspaceId)
    if (x.keyResultId) await assertEntityAccess(a, "keyResult", x.keyResultId)
  },
  request_decision: async (a, x) => {
    await assertWorkspaceMember(a, x.workspaceId)
    if (x.subjectType === "WORKSPACE") {
      if (x.subjectId !== x.workspaceId) throw new McpAuthzError("Decision subject does not belong to the declared workspace.")
      return
    }
    const entity = DECISION_SUBJECT_ENTITY[x.subjectType]
    if (!entity) throw new McpAuthzError(`Unknown decision subject type: ${x.subjectType}`)
    await assertChildInDeclaredWorkspace(a, entity, x.subjectId, x.workspaceId)
  },
  list_decisions: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_decision: (a, x) => assertChildInDeclaredWorkspace(a, "reviewRequest", x.requestId, x.workspaceId),
  close_decision_no_action: (a, x) => assertChildInDeclaredWorkspace(a, "reviewRequest", x.requestId, x.workspaceId),
  request_release_authorization: async (a, x) => void (await assertWorkspaceAdmin(a, x.workspaceId)),
  list_release_runs: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_review_request: async (a, x) => void (await assertEntityAccess(a, "reviewRequest", x.requestId)),
  list_review_requests: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  // Classified WRITE below (not human-only): the tool's registered
  // description ("Service actors may apply but cannot take decisions") is the
  // actual security contract. A service/agent actor may apply an already-
  // DECIDED record and receive its receipt; the decide step itself
  // (recordDecision in lib/decision-service.ts) is a separate, un-exposed
  // code path that independently throws HUMAN_ACTOR_REQUIRED for any
  // non-USER actor kind. Do not move this back to DENY.
  apply_recorded_decision: async (a, x) => void (await assertEntityAccess(a, "decisionRecord", x.decisionId)),

  // Launch tiers / checklists -------------------------------------------------
  // All five gate on Workspace.launchWorkflowEnabled in addition to normal
  // membership/entity access — the whole marketing-launch surface is opt-in
  // per workspace (default off). See lib/launch-checklist.ts's
  // assertLaunchWorkflowEnabled for the shared rejection message.
  create_checklist_template: async (a, x) => {
    await assertWorkspaceMember(a, x.workspaceId)
    await assertLaunchWorkflowEnabled(x.workspaceId)
  },
  list_checklist_templates: async (a, x) => {
    await assertWorkspaceMember(a, x.workspaceId)
    await assertLaunchWorkflowEnabled(x.workspaceId)
  },
  set_launch_tier: async (a, x) => {
    const { workspaceId } = await assertEntityAccess(a, "roadmapItem", x.itemId)
    await assertLaunchWorkflowEnabled(workspaceId)
  },
  get_launch_checklist: async (a, x) => {
    const { workspaceId } = await assertEntityAccess(a, "roadmapItem", x.roadmapItemId)
    await assertLaunchWorkflowEnabled(workspaceId)
  },
  update_launch_checklist_item: async (a, x) => {
    const { workspaceId } = await assertEntityAccess(a, "launchChecklistItem", x.itemId)
    await assertLaunchWorkflowEnabled(workspaceId)
  },

  // Squads ------------------------------------------------------------------
  create_squad: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  list_squads: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_squad: async (a, x) => void (await assertEntityAccess(a, "squad", x.squadId)),
  update_squad: async (a, x) => void (await assertEntityAccess(a, "squad", x.squadId)),
  assign_squad: async (a, x) => {
    const entity = ASSIGN_SQUAD_ENTITY[x.objectType]
    if (!entity) throw new McpAuthzError(`Unknown objectType: ${x.objectType}`)
    await assertEntityAccess(a, entity, x.objectId)
    if (x.squadId) await assertEntityAccess(a, "squad", x.squadId)
  },

  // Custom Fields -------------------------------------------------------------
  list_custom_field_definitions: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_custom_field_values: assertCustomFieldObjectAccess,
  set_custom_field_value: assertCustomFieldObjectAccess,

  // Tasks -------------------------------------------------------------------
  create_task: async (a, x) => {
    await assertWorkspaceMember(a, x.workspaceId)
    if (x.parentTaskId) await assertChildInDeclaredWorkspace(a, "task", x.parentTaskId, x.workspaceId)
    if (x.squadId) await assertChildInDeclaredWorkspace(a, "squad", x.squadId, x.workspaceId)
  },
  get_task: async (a, x) => void (await assertEntityAccess(a, "task", x.taskId)),
  list_tasks: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  update_task: async (a, x) => void (await assertEntityAccess(a, "task", x.taskId)),
  move_task_status: async (a, x) => void (await assertEntityAccess(a, "task", x.taskId)),
  link_task: async (a, x) => {
    const { workspaceId } = await assertEntityAccess(a, "task", x.taskId)
    const entity = TASK_LINK_ENTITY[x.linkedType]
    if (!entity) throw new McpAuthzError(`Unknown linkedType: ${x.linkedType}`)
    await assertChildInDeclaredWorkspace(a, entity, x.linkedId, workspaceId)
  },
  unlink_task: async (a, x) => void (await assertEntityAccess(a, "task", x.taskId)),
  list_task_links: async (a, x) => void (await assertEntityAccess(a, "task", x.taskId)),

  // Feedback ----------------------------------------------------------------
  create_feedback: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  list_feedback: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_feedback_item: async (a, x) => void (await assertEntityAccess(a, "feedbackItem", x.feedbackId)),
  update_feedback: async (a, x) => void (await assertEntityAccess(a, "feedbackItem", x.feedbackId)),
  update_feedback_status: async (a, x) => void (await assertEntityAccess(a, "feedbackItem", x.feedbackId)),
  link_feedback_to_opportunity: async (a, x) => {
    const { workspaceId } = await assertEntityAccess(a, "feedbackItem", x.feedbackId)
    await assertChildInDeclaredWorkspace(a, "opportunity", x.opportunityId, workspaceId)
  },
  update_feedback_type: async (a, x) => void (await assertEntityAccess(a, "feedbackItem", x.feedbackId)),
  prepare_feedback_attachment_upload: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  add_feedback_attachment: async (a, x) => void (await assertEntityAccess(a, "feedbackItem", x.feedbackId)),
  promote_feedback_to_roadmap: (a, x) => assertChildInDeclaredWorkspace(a, "feedbackItem", x.feedbackId, x.workspaceId),

  // Evidence ----------------------------------------------------------------
  add_evidence: async (a, x) => {
    await assertWorkspaceMember(a, x.workspaceId)
    const targetWs = await assertEvidenceTarget(a, x)
    if (targetWs !== x.workspaceId) {
      throw new McpAuthzError("Evidence target does not belong to the declared workspace.")
    }
  },
  link_evidence: async (a, x) => {
    await assertEntityAccess(a, "evidence", x.evidenceId)
    await assertEvidenceTarget(a, x)
  },
  list_evidence: async (a, x) => void (await assertEntityAccess(a, x.nodeType as WorkspaceEntityType, x.nodeId)),

  // Docs --------------------------------------------------------------------
  list_docs: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_doc: async (a, x) => void (await assertEntityAccess(a, "doc", x.docId)),
  create_doc: async (a, x) => {
    await assertWorkspaceMember(a, x.workspaceId)
    if (x.parentId) await assertChildInDeclaredWorkspace(a, "doc", x.parentId, x.workspaceId)
    if (x.roadmapItemId) await assertChildInDeclaredWorkspace(a, "roadmapItem", x.roadmapItemId, x.workspaceId)
    // Positioning briefs are part of the marketing-launch surface, gated the
    // same as the launch-tier/checklist tools above.
    if (x.docType === "GTM_POSITIONING_BRIEF") await assertLaunchWorkflowEnabled(x.workspaceId)
  },
  update_doc: async (a, x) => void (await assertEntityAccess(a, "doc", x.docId)),
  create_doc_version: async (a, x) => void (await assertEntityAccess(a, "doc", x.docId)),
  list_doc_versions: async (a, x) => void (await assertEntityAccess(a, "doc", x.docId)),
  get_doc_version: async (a, x) => void (await assertEntityAccess(a, "docVersion", x.versionId)),
  restore_doc_version: async (a, x) => void (await assertEntityAccess(a, "docVersion", x.versionId)),
  add_doc_comment: async (a, x) => void (await assertEntityAccess(a, "doc", x.docId)),
  list_doc_comments: async (a, x) => void (await assertEntityAccess(a, "doc", x.docId)),
  get_doc_comment: async (a, x) => void (await assertEntityAccess(a, "docComment", x.commentId)),
  update_doc_comment: async (a, x) => void (await assertEntityAccess(a, "docComment", x.commentId)),
  delete_doc_comment: async (a, x) => void (await assertEntityAccess(a, "docComment", x.commentId)),
  resolve_doc_comment: async (a, x) => void (await assertEntityAccess(a, "docComment", x.commentId)),
  reopen_doc_comment: async (a, x) => void (await assertEntityAccess(a, "docComment", x.commentId)),

  // Artifacts ---------------------------------------------------------------
  list_artifacts: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_artifact: async (a, x) => void (await assertEntityAccess(a, "artifact", x.artifactId)),
  create_artifact: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  update_artifact: (a, x) => assertChildInDeclaredWorkspace(a, "artifact", x.artifactId, x.workspaceId),
  link_artifact_to_solution: async (a, x) => {
    await assertChildInDeclaredWorkspace(a, "artifact", x.artifactId, x.workspaceId)
    await assertChildInDeclaredWorkspace(a, "solution", x.solutionId, x.workspaceId)
  },
  unlink_artifact_from_solution: async (a, x) => {
    await assertChildInDeclaredWorkspace(a, "artifact", x.artifactId, x.workspaceId)
    await assertChildInDeclaredWorkspace(a, "solution", x.solutionId, x.workspaceId)
  },
  archive_artifact: (a, x) => assertChildInDeclaredWorkspace(a, "artifact", x.artifactId, x.workspaceId),
  link_artifact_to_decision: async (a, x) => {
    await assertChildInDeclaredWorkspace(a, "artifact", x.artifactId, x.workspaceId)
    await assertChildInDeclaredWorkspace(a, "reviewRequest", x.requestId, x.workspaceId)
  },
  unlink_artifact_from_decision: async (a, x) => {
    await assertChildInDeclaredWorkspace(a, "artifact", x.artifactId, x.workspaceId)
    await assertChildInDeclaredWorkspace(a, "reviewRequest", x.requestId, x.workspaceId)
  },

  // Help ----------------------------------------------------------------
  // search_help / get_help read Compass's own static product documentation
  // (docs/content/*.md) -- not workspace- or org-scoped data, so there is
  // nothing to authorize beyond "the caller has a valid MCP key", which
  // validateMcpAuth already established before any gate runs. Explicit
  // no-op entries (rather than omission) so the fail-closed completeness
  // check in __tests__/mcp-tool-gates.test.ts passes deliberately, not by
  // accident.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  search_help: async (_a, _x) => {},
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  get_help: async (_a, _x) => {},

  // Scoring models (org-scoped) ---------------------------------------------
  list_scoring_models: async (a, x) => void (await assertOrgMemberBySlug(a, x.orgSlug)),
  get_scoring_model: async (a, x) => void (await assertScoringModelAccess(a, x.scoringModelId)),
  create_scoring_model: async (a, x) => void (await assertOrgAdminBySlug(a, x.orgSlug)),
  update_scoring_model: async (a, x) => void (await assertScoringModelAccess(a, x.scoringModelId, { admin: true })),
  archive_scoring_model: async (a, x) => void (await assertScoringModelAccess(a, x.scoringModelId, { admin: true })),
  get_workspace_scoring_model: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  set_workspace_scoring_model: async (a, x) => {
    await assertWorkspaceAdmin(a, x.workspaceId)
    if (x.scoringModelId) await assertScoringModelAccess(a, x.scoringModelId)
  },
  score_opportunity: async (a, x) => void (await assertEntityAccess(a, "opportunity", x.opportunityId)),
  get_opportunity_score: async (a, x) => void (await assertEntityAccess(a, "opportunity", x.opportunityId)),
  // list_top_opportunities filters org-mode results to the caller's
  // workspaces in the handler; here we gate the two entry shapes.
  list_top_opportunities: async (a, x) => {
    if (x.workspaceId) {
      await assertWorkspaceMember(a, x.workspaceId)
    } else if (x.orgSlug) {
      await assertOrgMemberBySlug(a, x.orgSlug)
    } else {
      throw new McpAuthzError("Either workspaceId or orgSlug is required.")
    }
  },
}

/**
 * OAuth scope classification for the MCP catalog — the read/write distinction
 * TOOL_GATES does not encode.
 *
 * TOOL_GATES answers "may this identity touch this workspace?"; this map answers
 * a different, orthogonal question: "is this operation a read or a write?" An
 * OAuth access token carries `mcp:read` and/or `mcp:write`, and the MCP route
 * turns a shortfall into a 403 + `insufficient_scope` challenge before the gate
 * ever runs. Both checks apply — a scope never widens a membership.
 *
 * It is also deliberately **not** derived from AGENT_TOOL_POLICY, which looks
 * superficially similar and is answering a third question again (may a delegated
 * agent identity perform this at all?). Its DENY entries are all writes, but
 * "human-only" and "mutating" are not the same predicate, and collapsing them
 * would silently reclassify a tool the day either list moved.
 *
 * FAIL-CLOSED, twice over: `requiredToolScope` returns `mcp:write` for a name
 * it does not know, and a completeness test (__tests__/mcp-tool-gates.test.ts)
 * asserts every registered tool appears here — the same pair of guarantees
 * TOOL_GATES has.
 */
const READ_TOOLS = [
  "get_artifact", "get_comment", "get_current_identity", "get_custom_field_values",
  "get_decision", "get_doc", "get_doc_comment", "get_doc_version", "get_experiment",
  "get_feedback_item", "get_help", "get_launch_checklist", "get_okr_cycle", "get_opportunity",
  "get_opportunity_score", "get_pm_interview", "get_research_session", "get_research_study",
  "get_review_request", "get_scoring_model", "get_solution_comment", "get_squad", "get_task",
  "get_workspace_by_slug", "get_workspace_scoring_model", "get_workspace_summary",
  "list_artifacts", "list_assumptions", "list_checklist_templates", "list_comments",
  "list_custom_field_definitions", "list_decisions", "list_doc_comments", "list_doc_versions",
  "list_docs", "list_eligible_parent_key_results", "list_evidence", "list_experiments",
  "list_feedback", "list_okr_cycles", "list_opportunities", "list_release_runs",
  "list_research_sessions", "list_research_studies", "list_research_syntheses",
  "list_review_requests", "list_roadmap_items", "list_scoring_models",
  "list_solution_comments", "list_solutions", "list_squads", "list_task_assignees",
  "list_task_links", "list_tasks", "list_top_opportunities", "list_workspaces", "search_help",
] as const

/**
 * Everything that creates, changes, deletes, or mints something. Three entries
 * are judgment calls worth naming:
 *
 *  - `generate_research_guide` and `generate_research_synthesis` write nothing
 *    a caller asked for by name, but both spend a model call and the latter
 *    stores a synthesis row. A read-only token should not be able to do either.
 *  - `prepare_feedback_attachment_upload` returns a signed upload target —
 *    handing out write capability is a write.
 *  - `score_opportunity` persists the score it computes; its sibling
 *    `get_opportunity_score` only reads one back.
 */
const WRITE_TOOLS = [
  "activate_research_study", "add_assumption", "add_comment", "add_doc_comment",
  "add_evidence", "add_feedback_attachment", "add_key_result", "add_solution",
  "add_solution_comment", "add_solution_plan", "add_to_roadmap", "apply_recorded_decision",
  "approve_solution_plan", "archive_artifact", "archive_research_study",
  "archive_scoring_model", "assign_squad", "close_decision_no_action", "close_research_study",
  "conclude_experiment", "create_artifact", "create_checklist_template", "create_doc",
  "create_doc_version", "create_experiment", "create_feedback", "create_objective",
  "create_okr_cycle", "create_opportunity", "create_research_study", "create_scoring_model",
  "create_squad", "create_task", "create_workspace", "delete_assumption", "delete_comment",
  "delete_doc_comment", "delete_key_result", "delete_objective", "delete_solution_comment",
  "generate_research_guide", "generate_research_synthesis", "issue_research_link",
  "link_artifact_to_decision", "link_artifact_to_solution", "link_evidence",
  "link_feedback_to_opportunity", "link_opportunity_to_kr", "link_task", "log_checkin",
  "log_experiment_result", "move_task_status", "prepare_feedback_attachment_upload",
  "promote_feedback_to_roadmap", "promote_research_finding_to_evidence", "promote_to_roadmap",
  "reject_solution_plan", "reopen_comment", "reopen_doc_comment", "request_decision",
  "request_release_authorization", "resolve_comment", "resolve_doc_comment",
  "restore_doc_version", "revoke_research_links", "rotate_research_link", "score_opportunity",
  "set_custom_field_value", "set_launch_tier", "set_objective_parent_kr",
  "set_workspace_scoring_model", "unlink_artifact_from_decision",
  "unlink_artifact_from_solution", "unlink_task", "update_artifact", "update_assumption",
  "update_comment", "update_doc", "update_doc_comment", "update_experiment", "update_feedback",
  "update_feedback_status", "update_feedback_type", "update_key_result",
  "update_launch_checklist_item", "update_objective", "update_opportunity",
  "update_opportunity_status", "update_research_study", "update_roadmap_item",
  "update_scoring_model", "update_solution", "update_solution_comment",
  "update_solution_status", "update_squad", "update_task",
] as const

export type ToolScope = typeof SCOPE_MCP_READ | typeof SCOPE_MCP_WRITE

export const TOOL_SCOPES: Record<string, ToolScope> = Object.fromEntries([
  ...READ_TOOLS.map((name) => [name, SCOPE_MCP_READ]),
  ...WRITE_TOOLS.map((name) => [name, SCOPE_MCP_WRITE]),
])

/**
 * The scope a tool call requires. An unclassified name demands `mcp:write` —
 * the stronger of the two — so a tool added without a classification cannot
 * slip through on a read-only token. (`applyToolGate` would deny it anyway for
 * want of a gate; this keeps the scope layer independently fail-closed.)
 */
export function requiredToolScope(toolName: string): ToolScope {
  return TOOL_SCOPES[toolName] ?? SCOPE_MCP_WRITE
}

/**
 * Whether a granted scope set satisfies a requirement.
 *
 * `mcp:write` implies `mcp:read`. That is a hierarchy, not a shortcut: the
 * consent screen already describes write as "Create and change **that same**
 * data", and without the implication a client that requested write alone could
 * not even complete `initialize` — which is a read — leaving it unable to do
 * the one thing it was granted.
 */
export function scopesSatisfy(granted: readonly string[], required: ToolScope): boolean {
  if (granted.includes(SCOPE_MCP_WRITE)) return true
  return required === SCOPE_MCP_READ && granted.includes(SCOPE_MCP_READ)
}

// Every operation is explicitly classified. Unlisted tools fail closed for agents.
export const AGENT_TOOL_POLICY: Record<string, "READ" | "WRITE" | "DENY"> = Object.fromEntries([
  ["get_pm_interview", "READ"],
  ["update_experiment", "WRITE"],
  // Research tools reviewed 2026-09-13. Reads return only publicMetadata()
  // (id, workspaceId, name, goal, studyType, guide, targetMinutes, appUrl,
  // status, timestamps, sessionCount) — no transcripts, participant
  // identities, credentials or storage paths. Authoring mutations are
  // ordinary workspace writes. Participant-link issuance and study
  // activation stay DENY: they mint or return live participant access.
  // Transcript reads added 2026-09-14 for ADR-0012 step 3. They return ordered
  // ResearchTurn text plus an allowlisted session projection (id, studyId,
  // modality, status, timestamps, endedReason, turnCount, hasSummary) built
  // field-by-field in lib/research-study-service.ts — never participant names or
  // emails, resume/participant token material, audioUrl, voice-lease or
  // active-request state, and never the raw overloaded `summary` column. They
  // resolve through findMemberStudy, which excludes PM_INTERVIEW studies, so
  // they cannot read a PM interview (that stays owner-scoped via
  // get_pm_interview). Reading saved transcripts is an ordinary member read, so
  // READ rather than DENY; the participant-link tools above remain human-only
  // because they mint live access.
  // ADR-0012 step 4. list_research_syntheses returns only CROSS_SESSION rows,
  // so it never exposes the generation lease's claim ids or deadlines — an
  // ordinary member read. generate_research_synthesis writes a research
  // artifact, not discovery state: the row is already leased and idempotent,
  // every citation is re-validated against saved transcripts before storage,
  // and it cannot create Evidence. That is the same authority as
  // update_research_study, hence WRITE rather than DENY.
  ...["list_research_studies", "get_research_study", "list_research_sessions", "get_research_session", "list_research_syntheses"].map(name => [name, "READ"]),
  // ADR-0012 step 5. promote_research_finding_to_evidence is WRITE, not DENY.
  //
  // DENY was considered and rejected. ADR-0002 invariant 6 ("promotion always
  // requires human review") is satisfied structurally, by this tool's absence
  // from RESEARCH_SYNTHESIS_TOOLS: a scoped generation claim is refused it by
  // gateInterviewTool before this map is consulted at all. This map governs a
  // different question — whether a workspace's own delegated agent identity,
  // acting in an ordinary unscoped turn, may perform the write.
  //
  // For that question WRITE is the only coherent answer, because add_evidence is
  // already WRITE. Denying the provenance-carrying tool while permitting the
  // unattributed one would not prevent a single Evidence row; it would only push
  // agents onto add_evidence with a re-typed sourceUrl — the exact gap ADR-0002
  // named and this ADR exists to close. The tool is also strictly narrower than
  // add_evidence: its excerpt and citations come from a stored, re-grounded
  // synthesis rather than from free text, and it converges on retry.
  ...["generate_research_guide", "create_research_study", "update_research_study", "generate_research_synthesis", "promote_research_finding_to_evidence"].map(name => [name, "WRITE"]),
  ...["activate_research_study", "close_research_study", "archive_research_study", "issue_research_link", "rotate_research_link", "revoke_research_links"].map(name => [name, "DENY"]),
  ...[
    "get_current_identity", "list_task_assignees", "list_comments", "get_comment", "get_workspace_summary", "list_workspaces", "get_workspace_by_slug", "list_okr_cycles", "get_okr_cycle", "list_eligible_parent_key_results", "list_opportunities", "list_solutions", "list_assumptions", "get_opportunity", "list_solution_comments", "get_solution_comment", "list_experiments", "get_experiment", "list_roadmap_items", "list_decisions", "get_decision", "list_release_runs", "get_review_request", "list_review_requests", "list_checklist_templates", "get_launch_checklist", "list_squads", "get_squad", "get_task", "list_tasks", "list_task_links", "list_feedback", "get_feedback_item", "list_evidence", "list_docs", "get_doc", "list_doc_versions", "get_doc_version", "list_doc_comments", "get_doc_comment", "list_artifacts", "get_artifact", "search_help", "get_help", "list_scoring_models", "get_scoring_model", "get_workspace_scoring_model", "get_opportunity_score", "list_top_opportunities", "list_custom_field_definitions", "get_custom_field_values",
  ].map(name => [name, "READ"]),
  ...[
    "link_artifact_to_decision", "unlink_artifact_from_decision",
    "add_comment", "delete_comment", "resolve_comment", "reopen_comment", "create_okr_cycle", "create_objective", "update_objective", "delete_objective", "add_key_result", "update_key_result", "delete_key_result", "log_checkin", "set_objective_parent_kr", "create_opportunity", "update_opportunity", "update_opportunity_status", "link_opportunity_to_kr", "add_solution", "update_solution_status", "update_solution", "add_assumption", "update_assumption", "delete_assumption", "promote_to_roadmap", "add_solution_plan", "add_solution_comment", "delete_solution_comment", "create_experiment", "log_experiment_result", "conclude_experiment", "update_roadmap_item", "add_to_roadmap", "request_decision", "close_decision_no_action", "apply_recorded_decision", "create_checklist_template", "set_launch_tier", "update_launch_checklist_item", "create_squad", "update_squad", "assign_squad", "create_task", "update_task", "move_task_status", "link_task", "unlink_task", "create_feedback", "update_feedback", "update_feedback_status", "link_feedback_to_opportunity", "update_feedback_type", "prepare_feedback_attachment_upload", "add_feedback_attachment", "promote_feedback_to_roadmap", "add_evidence", "link_evidence", "create_doc", "update_doc", "create_doc_version", "restore_doc_version", "add_doc_comment", "delete_doc_comment", "resolve_doc_comment", "reopen_doc_comment", "create_artifact", "update_artifact", "link_artifact_to_solution", "unlink_artifact_from_solution", "archive_artifact", "score_opportunity", "set_custom_field_value",
  ].map(name => [name, "WRITE"]),
  // Legacy comments lack a durable agent author ID; body edits could retain a human label or approval badge.
  ...["update_comment", "update_solution_comment", "update_doc_comment", "create_workspace", "approve_solution_plan", "reject_solution_plan", "request_release_authorization", "create_scoring_model", "update_scoring_model", "archive_scoring_model", "set_workspace_scoring_model"].map(name => [name, "DENY"]),
])

/**
 * Run the authorization gate for `toolName`. Fail-closed: a tool with no
 * policy entry is denied.
 */
export async function applyToolGate(toolName: string, actor: McpActor, args: Args): Promise<void> {
  await gateInterviewTool(actor, toolName, args)
  // The shared service key is trusted/global — skip gating entirely. Gates
  // (and fail-closed denial of unmapped tools) apply only to per-user keys,
  // which is exactly the untrusted surface we're protecting.
  if (isServiceActor(actor)) return
  if (actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN") {
    const policy = AGENT_TOOL_POLICY[toolName]
    if (!policy || policy === "DENY") throw new McpAuthzError(`Tool requires a human identity: ${toolName}`)
    actor.requiredAgentAccess = policy
  }
  if (isResearchActor(actor) && !RESEARCH_TOOL_ALLOWLIST.has(toolName)) {
    throw new McpAuthzError(`Tool is not available to research interviews: ${toolName}`)
  }
  const gate = TOOL_GATES[toolName]
  if (!gate) {
    throw new McpAuthzError(`No authorization policy registered for tool "${toolName}".`)
  }
  await gate(actor, args)
}
