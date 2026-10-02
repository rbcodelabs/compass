/**
 * Initial MCP → REST parity ledger for PR 1. The catalog digest makes an MCP
 * addition fail the contract test until this ledger is deliberately revised;
 * later program phases replace `planned` entries with endpoint compositions or
 * narrowly justified transport-only exclusions.
 */
export const MCP_PARITY_CATALOG = {
  toolCount: 190,
  sortedToolNamesSha256: "1f3de9ed543c3ed778cdb6e521aea08d1e595cc7e08b1dd2edaa6ff0d3b9e7d4",
} as const

export const MCP_REST_MAPPINGS: Record<string, readonly string[]> = {
  get_current_identity: ["getCurrentIdentity"],
  list_workspaces: ["listWorkspaces"],
  get_workspace_by_slug: ["listWorkspaces", "getWorkspace"],
  create_opportunity: ["createOpportunity"], get_opportunity: ["getOpportunity"], list_opportunities: ["listOpportunities"],
  update_opportunity: ["updateOpportunity"], update_opportunity_status: ["updateOpportunity"], link_opportunity_to_kr: ["updateOpportunity"],
  link_opportunity_to_objective: ["linkOpportunityObjective"], unlink_opportunity_from_objective: ["unlinkOpportunityObjective"],
  add_solution: ["createSolution"], list_solutions: ["listSolutions"], update_solution: ["updateSolution"], update_solution_status: ["updateSolution"],
  link_solution_to_key_result: ["linkSolutionKeyResult"], unlink_solution_from_key_result: ["unlinkSolutionKeyResult"],
  add_assumption: ["createAssumption"], list_assumptions: ["listAssumptions"], update_assumption: ["updateAssumption"], delete_assumption: ["deleteAssumption"],
  create_feedback: ["createFeedback"], get_feedback_item: ["getFeedback"], list_feedback: ["listFeedback"], update_feedback: ["updateFeedback"],
  update_feedback_status: ["updateFeedback"], update_feedback_type: ["updateFeedback"], link_feedback_to_opportunity: ["updateFeedback"],
  prepare_feedback_attachment_upload: ["prepareFeedbackAttachmentUpload"],
  create_task: ["createTask"], get_task: ["getTask"], list_tasks: ["listTasks"], update_task: ["updateTask"], move_task_status: ["updateTask"],
  link_task: ["linkTaskResource"], unlink_task: ["unlinkTaskResource"], list_task_links: ["getTask"],
  add_to_roadmap: ["createRoadmapItem"], list_roadmap_items: ["listRoadmapItems"], update_roadmap_item: ["updateRoadmapItem"],
} as const

export const REMAINING_PARITY_DISPOSITION = {
  status: "planned",
  phases: [2, 3, 4, 5],
  rationale: "Approved REST program phases progressively replace remaining MCP capabilities with resource endpoints or composed workflows; transport-only exclusions require an explicit phase-5 rationale.",
} as const
