/**
 * Handler functions for Solution MCP tools (update_solution).
 * Extracted into this module so it can be unit-tested without the MCP server layer.
 * Mirrors the updateAssumption pattern in lib/assumption-tool-handlers.ts.
 */

import { getMcpActivityPrisma as getPrisma } from "@/lib/analytics/activity"
import { getToolExpectedWhere } from "@/lib/mcp-tool-db"
import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { safeEntityUrl, withUrlLine } from "@/lib/compass-url"

export async function createSolution({ opportunityId, title, description }: { opportunityId: string; title: string; description?: string | null }) {
  const prisma = getPrisma()
  const opportunity = await prisma.opportunity.findUnique({ where: { id: opportunityId }, select: { id: true, title: true, workspaceId: true, workspace: { select: { slug: true, organization: { select: { slug: true } } } } } })
  if (!opportunity) return fail(`Opportunity "${opportunityId}" not found.`)
  const solution = await captureWorkspaceMutation(prisma, "solution", "create", "MCP", undefined, (tx) => tx.solution.create({ data: { workspaceId: opportunity.workspaceId, opportunityId, title: title.trim(), description: description?.trim() || null } }))
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
    select: { id: true, title: true, description: true, updatedAt: true },
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
