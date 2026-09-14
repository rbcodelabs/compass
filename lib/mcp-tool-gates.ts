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
import { gateInterviewTool } from "@/lib/pm-agent-service"

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
  request_building_investment: async (a, x) => void (await assertEntityAccess(a, "solution", x.solutionId)),
  reconsider_building_investment: async (a, x) => {
    await assertEntityAccess(a, "solution", x.solutionId)
    await assertEntityAccess(a, "decisionRecord", x.expectedTerminalDecisionId)
  },
  request_building_investment_revocation: async (a, x) => {
    await assertEntityAccess(a, "solution", x.solutionId)
    await assertEntityAccess(a, "decisionRecord", x.authorityDecisionId)
  },
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

  // Launch tiers / checklists ----------------------------------------------
  create_checklist_template: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  list_checklist_templates: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  set_launch_tier: async (a, x) => void (await assertEntityAccess(a, "roadmapItem", x.itemId)),
  get_launch_checklist: async (a, x) => void (await assertEntityAccess(a, "roadmapItem", x.roadmapItemId)),
  update_launch_checklist_item: async (a, x) => void (await assertEntityAccess(a, "launchChecklistItem", x.itemId)),

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
  ...["list_research_studies", "get_research_study"].map(name => [name, "READ"]),
  ...["generate_research_guide", "create_research_study", "update_research_study"].map(name => [name, "WRITE"]),
  ...["activate_research_study", "close_research_study", "archive_research_study", "issue_research_link", "rotate_research_link", "revoke_research_links"].map(name => [name, "DENY"]),
  ...[
    "get_current_identity", "list_task_assignees", "list_comments", "get_comment", "get_workspace_summary", "list_workspaces", "get_workspace_by_slug", "list_okr_cycles", "get_okr_cycle", "list_eligible_parent_key_results", "list_opportunities", "list_solutions", "list_assumptions", "get_opportunity", "list_solution_comments", "get_solution_comment", "list_experiments", "get_experiment", "list_roadmap_items", "list_decisions", "get_decision", "list_release_runs", "get_review_request", "list_review_requests", "list_checklist_templates", "get_launch_checklist", "list_squads", "get_squad", "get_task", "list_tasks", "list_task_links", "list_feedback", "get_feedback_item", "list_evidence", "list_docs", "get_doc", "list_doc_versions", "get_doc_version", "list_doc_comments", "get_doc_comment", "list_artifacts", "get_artifact", "search_help", "get_help", "list_scoring_models", "get_scoring_model", "get_workspace_scoring_model", "get_opportunity_score", "list_top_opportunities",
  ].map(name => [name, "READ"]),
  ...[
    "link_artifact_to_decision", "unlink_artifact_from_decision",
    "add_comment", "delete_comment", "resolve_comment", "reopen_comment", "create_okr_cycle", "create_objective", "update_objective", "delete_objective", "add_key_result", "update_key_result", "delete_key_result", "log_checkin", "set_objective_parent_kr", "create_opportunity", "update_opportunity", "update_opportunity_status", "link_opportunity_to_kr", "add_solution", "update_solution_status", "update_solution", "add_assumption", "update_assumption", "delete_assumption", "promote_to_roadmap", "add_solution_plan", "add_solution_comment", "delete_solution_comment", "create_experiment", "log_experiment_result", "conclude_experiment", "update_roadmap_item", "add_to_roadmap", "request_decision", "close_decision_no_action", "apply_recorded_decision", "request_building_investment", "reconsider_building_investment", "request_building_investment_revocation", "create_checklist_template", "set_launch_tier", "update_launch_checklist_item", "create_squad", "update_squad", "assign_squad", "create_task", "update_task", "move_task_status", "link_task", "unlink_task", "create_feedback", "update_feedback", "update_feedback_status", "link_feedback_to_opportunity", "update_feedback_type", "prepare_feedback_attachment_upload", "add_feedback_attachment", "promote_feedback_to_roadmap", "add_evidence", "link_evidence", "create_doc", "update_doc", "create_doc_version", "restore_doc_version", "add_doc_comment", "delete_doc_comment", "resolve_doc_comment", "reopen_doc_comment", "create_artifact", "update_artifact", "link_artifact_to_solution", "unlink_artifact_from_solution", "archive_artifact", "score_opportunity",
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
