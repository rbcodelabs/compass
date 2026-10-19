/**
 * Handlers for the generic link MCP tools (ADR phase 2): link_entities, unlink_entities, and the
 * generic mode of list_links. They sit next to lib/typed-link-tool-handlers.ts, whose per-pair tools
 * are untouched in this phase.
 *
 * Authorization already ran in lib/mcp-tool-gates.ts (REST callers pass workspace-membership checks in
 * lib/rest/execute.ts). These handlers still go through lib/links/service.ts, which re-verifies both
 * endpoints inside the write transaction and takes the stored workspaceId from the `from` row, so the
 * shared service key (which skips gates) cannot cross-link either. Every mutation is idempotent for
 * types whose duplicatePolicy says so: a repeat link reports `created: false`, a missing link `removed: 0`.
 *
 * Mutation responses end with an `ID: <link uuid>` line, the format agents already scrape.
 */
import { getMcpActivityPrisma as getPrisma } from "@/lib/analytics/activity"
import { fail, ok } from "@/lib/mcp-output"
import { linkEntities, listLinks, unlinkEntities } from "@/lib/links/service"
import { mcpLinkContext, listLinksTool as listTypedLinksTool } from "@/lib/typed-link-tool-handlers"
import { TypedLinkError, runTypedLinkTransaction, type LinkSource } from "@/lib/typed-links"

/** A TypedLinkError is an expected, user-safe outcome: report it as a failed result, never a thrown error. */
async function reportingLinkErrors<T>(work: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof TypedLinkError) return fail(error.message)
    throw error
  }
}

export const linkEntitiesTool = (args: { workspaceId: string; linkType: string; fromId: string; toId: string; toType?: string; attrs?: unknown; source?: LinkSource }) =>
  reportingLinkErrors(async () => {
    const ctx = mcpLinkContext(args.source)
    const result = await runTypedLinkTransaction(getPrisma(), (tx) =>
      linkEntities(tx, { linkType: args.linkType, fromId: args.fromId, toId: args.toId, toType: args.toType, attrs: args.attrs, expectedWorkspaceId: args.workspaceId, ctx }),
    )
    const subject = `${result.from.type} "${result.from.title}" and ${result.to.type} "${result.to.title}"`
    const text = [
      result.created ? `Linked ${subject} (${result.def.key}: ${result.def.labels.forward}).` : `${subject} are already linked (${result.def.key}).`,
      `ID: ${result.link.id}`,
    ].join("\n")
    return ok(text, {
      created: result.created,
      link: {
        id: result.link.id,
        workspaceId: result.link.workspaceId,
        linkType: result.link.linkType,
        fromType: result.link.fromType,
        fromId: result.link.fromId,
        toType: result.link.toType,
        toId: result.link.toId,
        origin: result.link.origin,
        source: result.link.source,
      },
    })
  })

export const unlinkEntitiesTool = (args: { workspaceId: string; linkType: string; fromId: string; toId: string }) =>
  reportingLinkErrors(async () => {
    const result = await runTypedLinkTransaction(getPrisma(), (tx) =>
      unlinkEntities(tx, { linkType: args.linkType, fromId: args.fromId, toId: args.toId, expectedWorkspaceId: args.workspaceId }),
    )
    const text = result.removed
      ? [`Removed the ${result.def.key} link.`, ...result.removedIds.map((id) => `ID: ${id}`)].join("\n")
      : "No such link; nothing to remove."
    return ok(text, { removed: result.removed, linkType: result.def.key, fromId: args.fromId, toId: args.toId })
  })

type ListArgs = {
  workspaceId: string
  opportunityId?: string
  objectiveId?: string
  solutionId?: string
  keyResultId?: string
  entityType?: string
  entityId?: string
  linkType?: string
  limit?: number
  cursor?: string
}

const generic = (args: ListArgs) =>
  reportingLinkErrors(async () => {
    if (!args.entityType || !args.entityId) throw new TypedLinkError("entityType and entityId must be given together.", "INVALID")
    const { items, nextCursor } = await listLinks(getPrisma(), {
      workspaceId: args.workspaceId,
      entityType: args.entityType,
      entityId: args.entityId,
      linkType: args.linkType,
      limit: args.limit ?? 50,
      cursor: args.cursor,
    })
    const lines = items.map(
      (item) => `• ${item.from.type} "${item.from.title}" → ${item.to.type} "${item.to.title}" [${item.linkType}, ${item.label}] — link ID: ${item.id}`,
    )
    return ok(lines.length ? lines.join("\n") : "No links found.", { items, count: items.length, nextCursor })
  })

/**
 * `list_links`, generalised additively. The original parameters (exactly one of opportunityId, objectiveId,
 * solutionId, keyResultId) behave exactly as before. Passing entityType + entityId (optionally linkType)
 * lists the registry-backed links on any entity instead.
 */
export const listLinksTool = (args: ListArgs) => {
  const legacy = [args.opportunityId, args.objectiveId, args.solutionId, args.keyResultId].filter(Boolean).length
  const genericMode = args.entityType !== undefined || args.entityId !== undefined || args.linkType !== undefined
  if (genericMode && legacy > 0) return Promise.resolve(fail("Provide either one of opportunityId, objectiveId, solutionId, keyResultId, or entityType with entityId, not both."))
  if (genericMode) return generic(args)
  return listTypedLinksTool(args)
}
