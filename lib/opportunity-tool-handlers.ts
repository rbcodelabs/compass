/** Handler functions for Opportunity MCP tools. */

import { getMcpActivityPrisma as getPrisma } from "@/lib/analytics/activity"
import { getToolExpectedWhere } from "@/lib/mcp-tool-db"
import { fail, ok } from "@/lib/mcp-output"
import { z } from "zod"
import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { getMcpActor } from "@/lib/mcp-authz"
import { setOpportunityKeyResult } from "@/lib/typed-links"
import {
  BatchRequestError, createOpportunityBatch, type BatchContext, type BatchItemResult, type OpportunityBatchItem,
} from "@/lib/opportunity-batch-create"
import { safeEntityUrl, withUrlLine } from "@/lib/compass-url"
import { workspaceMutationSource, type ProgrammaticSource } from "@/lib/programmatic-source"

function linkContext(source: ProgrammaticSource = "MCP") {
  const actor = getMcpActor()
  return { source, createdById: actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN" ? null : actor.userId }
}

/** Batch context for an MCP/REST caller: membership was proven by the tool gate, so the workspace is writable. */
export function programmaticBatchContext(workspaceId: string, source: ProgrammaticSource = "MCP"): BatchContext {
  const actor = getMcpActor()
  const agent = actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN"
  return {
    workspace: { id: workspaceId, isReadOnly: false },
    caller: agent ? "agent" : "human",
    source,
    mutationSource: workspaceMutationSource(source),
    createdById: agent ? null : actor.userId,
  }
}

/** Renders per-item results for the bulk tools; a partial failure is a successful call with failed items. */
export function batchResultOutput(noun: string, workspaceName: string, results: BatchItemResult[]) {
  const created = results.filter((r) => r.ok && !r.deduped).length
  const deduped = results.filter((r) => r.ok && r.deduped).length
  const failed = results.length - created - deduped
  const lines = results.map((r, i) => (r.ok ? `${i + 1}. ${r.deduped ? "already created" : "created"}: ${r.id}` : `${i + 1}. ${r.code}: ${r.error}`))
  return ok(`**${created} ${noun}${created === 1 ? "" : "s"} created** in "${workspaceName}"${deduped ? `, ${deduped} already existed` : ""}${failed ? `, ${failed} failed` : ""}\n${lines.join("\n")}`, { results, created, deduped, failed })
}

export async function createOpportunities(input: {
  workspaceId: string; items: OpportunityBatchItem[]; source?: ProgrammaticSource
}) {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { id: true, name: true } })
  if (!workspace) return fail(`Workspace "${input.workspaceId}" not found.`)
  try {
    const { results } = await createOpportunityBatch(prisma, programmaticBatchContext(input.workspaceId, input.source), input.items)
    return batchResultOutput("opportunity", workspace.name, results)
  } catch (error) {
    if (error instanceof BatchRequestError) return fail(error.message)
    throw error
  }
}

export async function createOpportunity(input: {
  workspaceId: string; title: string; description?: string | null; customerSegment?: string | null
  status?: "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE"; keyResultId?: string | null; squadId?: string | null; source?: ProgrammaticSource
}) {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { id: true, name: true, slug: true, organization: { select: { slug: true } } } })
  if (!workspace) return fail(`Workspace "${input.workspaceId}" not found.`)
  const { results } = await createOpportunityBatch(prisma, programmaticBatchContext(input.workspaceId, input.source), [{
    title: input.title, description: input.description, customerSegment: input.customerSegment, status: input.status,
    squadId: input.squadId, linkedKeyResultId: input.keyResultId,
  }])
  const result = results[0]
  if (!result.ok) return fail(result.error)
  const opportunity = await prisma.opportunity.findFirst({ where: { id: result.id, workspaceId: input.workspaceId }, select: { id: true, title: true, status: true, customerSegment: true, linkedKeyResultId: true, squadId: true } })
  if (!opportunity) return fail("The opportunity was created but could not be read back.")
  return ok(withUrlLine(
    `**Opportunity created** in "${workspace.name}"\nID: ${opportunity.id}\nTitle: ${opportunity.title}\nStatus: ${opportunity.status}`,
    safeEntityUrl({ orgSlug: workspace.organization?.slug, workspaceSlug: workspace.slug, type: "opportunity", id: opportunity.id }),
  ), {
    id: opportunity.id, title: opportunity.title, status: opportunity.status, workspaceId: input.workspaceId,
    customerSegment: opportunity.customerSegment, linkedKeyResultId: opportunity.linkedKeyResultId, squadId: opportunity.squadId,
  })
}

export async function updateOpportunityStatus(input: { opportunityId: string; status: "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE" | "ARCHIVED"; source?: ProgrammaticSource }) {
  const prisma = getPrisma()
  const current = await prisma.opportunity.findUnique({ where: { id: input.opportunityId }, select: { id: true, title: true, status: true } })
  if (!current) return fail(`Opportunity "${input.opportunityId}" not found.`)
  const updated = await captureWorkspaceMutation(prisma, "opportunity", "update", workspaceMutationSource(input.source), input.opportunityId, (tx) => tx.opportunity.update({ where: { id: input.opportunityId }, data: { status: input.status, updatedAt: new Date() } }))
  return ok(`**"${current.title}"** moved from ${current.status} → ${input.status}`, { id: updated.id, title: current.title, status: input.status, previousStatus: current.status })
}

export async function updateOpportunityKeyResult(input: { opportunityId: string; keyResultId: string | null; workspaceId?: string; source?: ProgrammaticSource }) {
  const prisma = getPrisma()
  try {
    const updated = await captureWorkspaceMutation(prisma, "opportunity", "update", workspaceMutationSource(input.source), input.opportunityId, (tx) => setOpportunityKeyResult(tx, { opportunityId: input.opportunityId, keyResultId: input.keyResultId, expectedWorkspaceId: input.workspaceId, ctx: linkContext(input.source) }), { atomic: true })
    return ok(input.keyResultId ? `Linked opportunity "${updated.title}" to KR ${input.keyResultId}.` : `Cleared KR link from opportunity "${updated.title}".`, { id: updated.id, title: updated.title, linkedKeyResultId: input.keyResultId })
  } catch (error) { return fail(error instanceof Error ? error.message : "Unable to update Key Result link.") }
}

type UpdateOpportunityInput = {
  opportunityId: string
  title?: string
  description?: string | null
  customerSegment?: string | null
  expectedUpdatedAt?: string
}

export async function updateOpportunity({
  opportunityId,
  title,
  description,
  customerSegment,
  expectedUpdatedAt,
}: UpdateOpportunityInput) {
  if (!z.string().uuid().safeParse(opportunityId).success) {
    return fail("A valid opportunity ID is required.")
  }
  if (title === undefined && description === undefined && customerSegment === undefined) {
    return fail("Provide at least one editable field: title or description.")
  }

  const normalizedTitle = title?.trim()
  if (customerSegment != null && customerSegment.trim().length > 255) return fail("Customer segment cannot exceed 255 characters.")
  if (title !== undefined && !normalizedTitle) {
    return fail("Opportunity title cannot be empty.")
  }
  if (normalizedTitle && normalizedTitle.length > 255) {
    return fail("Opportunity title cannot exceed 255 characters.")
  }

  const normalizedDescription = description === null ? null : description?.trim()
  if (description !== undefined && description !== null && !normalizedDescription) {
    return fail("Opportunity description cannot be empty; use null to clear it.")
  }

  const prisma = getPrisma()
  const existing = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: { id: true, title: true, description: true, status: true, customerSegment: true, updatedAt: true },
  })
  if (!existing) return fail(`Opportunity "${opportunityId}" not found.`)

  const data: {
    updatedAt: Date
    title?: string
    description?: string | null
    customerSegment?: string | null
  } = { updatedAt: new Date(Math.max(Date.now(), (existing.updatedAt?.getTime() ?? 0) + 1)) }
  if (normalizedTitle !== undefined && normalizedTitle !== existing.title) {
    data.title = normalizedTitle
  }
  if (normalizedDescription !== undefined && normalizedDescription !== existing.description) {
    data.description = normalizedDescription
  }

  if (customerSegment !== undefined) data.customerSegment = customerSegment?.trim() || null
  if (!("title" in data) && !("description" in data) && !("customerSegment" in data)) {
    return fail("No editable changes were provided.")
  }

  const updated = await prisma.opportunity.update({
    where: { id: opportunityId, ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {}), ...getToolExpectedWhere() },
    data,
    select: { id: true, title: true, description: true, status: true, customerSegment: true, updatedAt: true },
  })

  return ok(
    `**Opportunity updated**\nID: ${updated.id}\nTitle: ${updated.title}\nStatus: ${updated.status}`,
    {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      customerSegment: updated.customerSegment,
      updatedAt: updated.updatedAt,
      status: updated.status,
    },
  )
}
