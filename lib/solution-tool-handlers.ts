/**
 * Handler functions for Solution MCP tools (update_solution).
 * Extracted into this module so it can be unit-tested without the MCP server layer.
 * Mirrors the updateAssumption pattern in lib/assumption-tool-handlers.ts.
 */

import { getMcpActivityPrisma as getPrisma } from "@/lib/analytics/activity"
import { getToolExpectedWhere } from "@/lib/mcp-tool-db"
import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { safeEntityUrl, withUrlLine } from "@/lib/compass-url"
import { workspaceMutationSource, type ProgrammaticSource } from "@/lib/programmatic-source"
import { getMcpActor } from "@/lib/mcp-authz"
import { syncRoadmapOnSolutionChange } from "@/lib/roadmap/solution-sync"

export async function createSolution({ opportunityId, title, description, source = "MCP" }: { opportunityId: string; title: string; description?: string | null; source?: ProgrammaticSource }) {
  const prisma = getPrisma()
  const opportunity = await prisma.opportunity.findUnique({ where: { id: opportunityId }, select: { id: true, title: true, workspaceId: true, workspace: { select: { slug: true, organization: { select: { slug: true } } } } } })
  if (!opportunity) return fail(`Opportunity "${opportunityId}" not found.`)
  const solution = await captureWorkspaceMutation(prisma, "solution", "create", workspaceMutationSource(source), undefined, (tx) => tx.solution.create({ data: { workspaceId: opportunity.workspaceId, opportunityId, title: title.trim(), description: description?.trim() || null, source } }))
  return ok(withUrlLine(
    `**Solution created** for "${opportunity.title}"\nID: ${solution.id}\nTitle: ${solution.title}\nStatus: ${solution.status}`,
    safeEntityUrl({ orgSlug: opportunity.workspace?.organization?.slug, workspaceSlug: opportunity.workspace?.slug, type: "solution", id: solution.id, opportunityId }),
  ), { id: solution.id, title: solution.title, status: solution.status, opportunityId })
}
import { ok, fail } from "@/lib/mcp-output"

// ── update_solution ──────────────────────────────────────────────────────────

export async function updateSolution({
  solutionId,
  title,
  description,
  expectedUpdatedAt,
}: {
  solutionId: string
  title?: string
  description?: string
  expectedUpdatedAt?: string
}) {
  const prisma = getPrisma()

  const existing = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: { id: true, title: true, description: true, updatedAt: true, workspaceId: true },
  })
  if (!existing) {
    return fail(`Solution "${solutionId}" not found.`)
  }

  if (title === undefined && description === undefined) {
    return fail("At least one of title or description must be provided.")
  }

  // Build update payload imperatively to satisfy Prisma's union type constraints
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = { updatedAt: new Date(Math.max(Date.now(), (existing.updatedAt?.getTime() ?? 0) + 1)) }
  if (title !== undefined) updateData.title = title.trim()
  // Empty string is a valid "clear the description" value — only `undefined`
  // means "not provided", so don't special-case "" here.
  if (description !== undefined) updateData.description = description.trim()

  const updated = await prisma.solution.update({
    where: { id: solutionId, ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {}), ...getToolExpectedWhere() },
    data: updateData,
  })

  // Linked roadmap items that still carry the old title follow the rename. Best-effort and never throws.
  if (title !== undefined && existing.workspaceId && updated.title !== existing.title) {
    let userId: string | null = null
    try { userId = getMcpActor().userId ?? null } catch { userId = null }
    await syncRoadmapOnSolutionChange(
      prisma,
      { source: "MCP", captureSource: workspaceMutationSource("MCP"), userId },
      { solutionId, workspaceId: existing.workspaceId, previousTitle: existing.title, title: updated.title },
    )
  }

  return ok(
    `**Solution updated**\n` +
      `ID: ${updated.id}\n` +
      `Title: ${updated.title}\n` +
      `Description: ${updated.description ?? "(none)"}`,
    {
      id: updated.id,
      title: updated.title,
      description: updated.description,
    }
  )
}
