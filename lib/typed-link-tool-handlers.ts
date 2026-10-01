/**
 * Handlers for the typed-link MCP tools (ADR Phase 2):
 * link_opportunity_to_objective, unlink_opportunity_from_objective,
 * link_solution_to_key_result, unlink_solution_from_key_result, list_links.
 *
 * Authorization already ran in lib/mcp-tool-gates.ts. These handlers still go through
 * lib/typed-links.ts, which re-verifies both endpoints inside the write transaction and takes the
 * link's workspaceId from the parent row, so the shared service key (which skips gates) cannot cross-link
 * either. Every tool is idempotent: a repeat link reports `created: false`, a missing link `removed: 0`.
 */
import { getMcpActivityPrisma as getPrisma } from "@/lib/analytics/activity"
import { getMcpActor } from "@/lib/mcp-authz"
import { fail, ok } from "@/lib/mcp-output"
import {
  TypedLinkError,
  linkOpportunityToObjective,
  linkSolutionToKeyResult,
  listLinks,
  runTypedLinkTransaction,
  unlinkOpportunityFromObjective,
  unlinkSolutionFromKeyResult,
  type LinkContext,
} from "@/lib/typed-links"

/** Who made the link. A delegated agent carries its owner's userId but is not that user, so it is recorded as unattributed. */
export function mcpLinkContext(): LinkContext {
  const actor = getMcpActor()
  const isAgent = actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN"
  return { source: "MCP", createdById: isAgent ? null : actor.userId }
}

/** A TypedLinkError is an expected, user-safe outcome: report it as a failed result, never a thrown error. */
async function reportingLinkErrors<T>(work: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof TypedLinkError) return fail(error.message)
    throw error
  }
}

export const linkOpportunityToObjectiveTool = (args: { workspaceId: string; opportunityId: string; objectiveId: string }) =>
  reportingLinkErrors(async () => {
    const ctx = mcpLinkContext()
    const result = await runTypedLinkTransaction(getPrisma(), (tx) =>
      linkOpportunityToObjective(tx, { opportunityId: args.opportunityId, objectiveId: args.objectiveId, expectedWorkspaceId: args.workspaceId, ctx }),
    )
    const text = result.created
      ? `Linked opportunity "${result.opportunity.title}" to objective "${result.objective.title}".`
      : result.originFlipped
        ? `Opportunity "${result.opportunity.title}" was already linked to objective "${result.objective.title}" through its Key Result; the link is now a direct link and survives clearing that Key Result.`
        : `Opportunity "${result.opportunity.title}" is already linked to objective "${result.objective.title}".`
    return ok(text, {
      created: result.created,
      originFlipped: result.originFlipped,
      link: { id: result.link.id, workspaceId: result.link.workspaceId, opportunityId: args.opportunityId, objectiveId: args.objectiveId, origin: result.link.origin, source: result.link.source },
    })
  })

export const unlinkOpportunityFromObjectiveTool = (args: { workspaceId: string; opportunityId: string; objectiveId: string }) =>
  reportingLinkErrors(async () => {
    const result = await runTypedLinkTransaction(getPrisma(), (tx) =>
      unlinkOpportunityFromObjective(tx, { opportunityId: args.opportunityId, objectiveId: args.objectiveId, expectedWorkspaceId: args.workspaceId }),
    )
    const text = result.stillLinkedViaKeyResult
      ? "The opportunity's linked Key Result is under this objective, so the objective link remains. Clear the Key Result with link_opportunity_to_kr (keyResultId: null) to remove it."
      : result.removed
        ? "Removed the link between the opportunity and the objective."
        : "No such link; nothing to remove."
    return ok(text, { removed: result.removed, ...(result.stillLinkedViaKeyResult ? { stillLinkedViaKeyResult: true } : {}), opportunityId: args.opportunityId, objectiveId: args.objectiveId })
  })

export const linkSolutionToKeyResultTool = (args: { workspaceId: string; solutionId: string; keyResultId: string }) =>
  reportingLinkErrors(async () => {
    const ctx = mcpLinkContext()
    const result = await runTypedLinkTransaction(getPrisma(), (tx) =>
      linkSolutionToKeyResult(tx, { solutionId: args.solutionId, keyResultId: args.keyResultId, expectedWorkspaceId: args.workspaceId, ctx }),
    )
    const text = result.created
      ? `Linked solution "${result.solution.title}" to key result "${result.keyResult.title}".`
      : `Solution "${result.solution.title}" is already linked to key result "${result.keyResult.title}".`
    return ok(text, {
      created: result.created,
      link: { id: result.link.id, workspaceId: result.link.workspaceId, solutionId: args.solutionId, keyResultId: args.keyResultId, source: result.link.source },
    })
  })

export const unlinkSolutionFromKeyResultTool = (args: { workspaceId: string; solutionId: string; keyResultId: string }) =>
  reportingLinkErrors(async () => {
    const result = await runTypedLinkTransaction(getPrisma(), (tx) =>
      unlinkSolutionFromKeyResult(tx, { solutionId: args.solutionId, keyResultId: args.keyResultId, expectedWorkspaceId: args.workspaceId }),
    )
    return ok(result.removed ? "Removed the link between the solution and the key result." : "No such link; nothing to remove.", {
      removed: result.removed,
      solutionId: args.solutionId,
      keyResultId: args.keyResultId,
    })
  })

export const listLinksTool = (args: { workspaceId: string; opportunityId?: string; objectiveId?: string; solutionId?: string; keyResultId?: string; limit?: number; cursor?: string }) =>
  reportingLinkErrors(async () => {
    const { items, nextCursor } = await listLinks(getPrisma(), { ...args, limit: args.limit ?? 50 })
    const lines = items.map((item) =>
      item.kind === "opportunity_objective"
        ? `• Opportunity "${item.opportunityTitle}" ↔ Objective "${item.objectiveTitle}" [${item.origin}] — link ID: ${item.id}`
        : `• Solution "${item.solutionTitle}" ↔ Key Result "${item.keyResultTitle}" — link ID: ${item.id}`,
    )
    return ok(lines.length ? lines.join("\n") : "No links found.", { items, count: items.length, nextCursor })
  })
