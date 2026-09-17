import { McpAuthzError } from "@/lib/mcp-authz"
import type { ProcessingState } from "@/lib/pm-agent-processing"

/**
 * The `RESEARCH_SYNTHESIS` scoped gate (ADR-0012 step 4).
 *
 * ADR-0011's PM kind needed a target-bound *field* allowlist because its claim
 * authorizes editing someone else's discovery item. This kind needs strictly
 * less: the claim may read one study and write that study's own
 * `ResearchSynthesis` row, which is a record of analysis rather than a
 * discovery claim, and which is independently leased and validated.
 *
 * So the policy is a closed allowlist rather than a per-tool rule set. Anything
 * not named here is denied — including every discovery mutation, every
 * participant-link tool (those mint live access), and the PM kind's own tools.
 * ADR-0002 invariant 6 and ADR-0012's "Phase 2 — unscoped" both depend on this:
 * promotion into Evidence must happen in a later turn carrying the researcher's
 * ordinary authority, never on this claim's authority.
 */
export const RESEARCH_SYNTHESIS_TOOLS = new Set<string>([
  "get_research_study",
  "list_research_sessions",
  "get_research_session",
  "list_research_syntheses",
  "generate_research_synthesis",
  // DO NOT ADD `promote_research_finding_to_evidence` HERE.
  //
  // It is absent on purpose, and its absence IS the human-review gate that
  // ADR-0002 invariant 6 requires. A claimed turn that could both generate a
  // synthesis and promote its own findings would be an unattended agent writing
  // discovery state on its own authority — the single thing ADR-0012's authority
  // design exists to prevent. Promotion is meant to be impossible here and
  // ordinary one turn later, when the researcher continues the conversation as
  // themselves and the tool runs under their own permissions (ADR-0012 "Phase 2
  // — unscoped"). Adding it would collapse the two phases into one and silently
  // remove the review step, with no other control left to catch it.
  //
  // If an agent genuinely needs to promote findings, that is an AGENT_TOOL_POLICY
  // question in lib/mcp-tool-gates.ts (where it is classified WRITE), not a
  // reason to widen this claim. Covered by __tests__/lib/research-synthesis-scope.test.ts.
])

/**
 * Every allowlisted tool takes a `studyId`, so the binding is uniform: the
 * argument must be the exact study the claim was minted for. A claim with no
 * `studyId` authorizes nothing at all rather than everything — fail-closed, and
 * it is what makes a malformed or hand-edited processing blob inert.
 */
export function assertResearchSynthesisToolInput(state: ProcessingState, tool: string, args: Record<string, unknown>) {
  if (!RESEARCH_SYNTHESIS_TOOLS.has(tool)) throw new McpAuthzError(`Tool is outside this research synthesis: ${tool}`)
  if (typeof state.studyId !== "string" || !state.studyId || args.studyId !== state.studyId) {
    throw new McpAuthzError("Tool target is outside this research synthesis")
  }
}
