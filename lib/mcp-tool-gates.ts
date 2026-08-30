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
 *   - service key (userId === null) → every assert is a no-op (global/trusted).
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
  assertWorkspaceMember,
  assertWorkspaceAdmin,
  assertWorkspaceBySlug,
  assertOrgMemberBySlug,
  assertOrgAdminBySlug,
  assertEntityAccess,
  assertScoringModelAccess,
} from "@/lib/mcp-authz"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any> // runtime-validated by each tool's zod inputSchema
type Gate = (actor: McpActor, args: Args) => Promise<void>

// ── Polymorphic target maps (values are WorkspaceEntityType) ────────────────

const ASSIGN_SQUAD_ENTITY: Record<string, WorkspaceEntityType> = {
  opportunity: "opportunity",
  experiment: "experiment",
  roadmap_item: "roadmapItem",
  objective: "objective",
  task: "task",
}

// Mirrors LINK_TARGET_MODEL in lib/task-tool-handlers.ts.
const TASK_LINK_ENTITY: Record<string, WorkspaceEntityType> = {
  OPPORTUNITY: "opportunity",
  SOLUTION: "solution",
  ROADMAP_ITEM: "roadmapItem",
  OBJECTIVE: "objective",
  KEY_RESULT: "keyResult",
  DOC: "doc",
  EXPERIMENT: "experiment",
  FEEDBACK_ITEM: "feedbackItem",
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
  add_key_result: async (a, x) => void (await assertEntityAccess(a, "objective", x.objectiveId)),
  log_checkin: async (a, x) => void (await assertEntityAccess(a, "keyResult", x.keyResultId)),
  set_objective_parent_kr: async (a, x) => {
    await assertEntityAccess(a, "objective", x.objectiveId)
    if (x.keyResultId) await assertEntityAccess(a, "keyResult", x.keyResultId)
  },
  list_eligible_parent_key_results: (a, x) => assertChildInDeclaredWorkspace(a, "okrCycle", x.cycleId, x.workspaceId),

  // Discovery ---------------------------------------------------------------
  list_opportunities: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_opportunity: async (a, x) => void (await assertEntityAccess(a, "opportunity", x.opportunityId)),
  create_opportunity: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  update_opportunity_status: async (a, x) => void (await assertEntityAccess(a, "opportunity", x.opportunityId)),
  link_opportunity_to_kr: async (a, x) => {
    await assertEntityAccess(a, "opportunity", x.opportunityId)
    if (x.keyResultId) await assertEntityAccess(a, "keyResult", x.keyResultId)
  },
  add_solution: async (a, x) => void (await assertEntityAccess(a, "opportunity", x.opportunityId)),
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
  },
  get_task: async (a, x) => void (await assertEntityAccess(a, "task", x.taskId)),
  list_tasks: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  update_task: async (a, x) => void (await assertEntityAccess(a, "task", x.taskId)),
  move_task_status: async (a, x) => void (await assertEntityAccess(a, "task", x.taskId)),
  link_task: async (a, x) => {
    await assertEntityAccess(a, "task", x.taskId)
    const entity = TASK_LINK_ENTITY[x.linkedType]
    if (!entity) throw new McpAuthzError(`Unknown linkedType: ${x.linkedType}`)
    await assertEntityAccess(a, entity, x.linkedId)
  },
  unlink_task: async (a, x) => void (await assertEntityAccess(a, "task", x.taskId)),
  list_task_links: async (a, x) => void (await assertEntityAccess(a, "task", x.taskId)),

  // Feedback ----------------------------------------------------------------
  create_feedback: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  list_feedback: (a, x) => assertWorkspaceMember(a, x.workspaceId),
  get_feedback_item: async (a, x) => void (await assertEntityAccess(a, "feedbackItem", x.feedbackId)),
  update_feedback_status: async (a, x) => void (await assertEntityAccess(a, "feedbackItem", x.feedbackId)),
  link_feedback_to_opportunity: async (a, x) => {
    const { workspaceId } = await assertEntityAccess(a, "feedbackItem", x.feedbackId)
    await assertChildInDeclaredWorkspace(a, "opportunity", x.opportunityId, workspaceId)
  },
  update_feedback_type: async (a, x) => void (await assertEntityAccess(a, "feedbackItem", x.feedbackId)),
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
 * Run the authorization gate for `toolName`. Fail-closed: a tool with no
 * policy entry is denied.
 */
export async function applyToolGate(toolName: string, actor: McpActor, args: Args): Promise<void> {
  // The shared service key is trusted/global — skip gating entirely. Gates
  // (and fail-closed denial of unmapped tools) apply only to per-user keys,
  // which is exactly the untrusted surface we're protecting.
  if (isServiceActor(actor)) return
  const gate = TOOL_GATES[toolName]
  if (!gate) {
    throw new McpAuthzError(`No authorization policy registered for tool "${toolName}".`)
  }
  await gate(actor, args)
}
