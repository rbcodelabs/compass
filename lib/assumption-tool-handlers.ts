/**
 * Handler functions for Assumption MCP tools (update_assumption, delete_assumption).
 * Extracted into this module so they can be unit-tested without the MCP server layer.
 * Mirrors the add_assumption tool (still inline in app/api/mcp/route.ts).
 */

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import getDatabase, { type AppTransactionClient } from "@/lib/db"
import { getToolPrisma as getPrisma, getToolExpectedWhere } from "@/lib/mcp-tool-db"
import { ok, fail } from "@/lib/mcp-output"

// ── update_assumption ───────────────────────────────────────────────────────

export async function updateAssumption({
  assumptionId,
  title,
  description,
  riskLevel,
  status,
  expectedUpdatedAt,
}: {
  assumptionId: string
  title?: string
  description?: string | null
  riskLevel?: "HIGH" | "MEDIUM" | "LOW"
  status?: "UNTESTED" | "TESTING" | "VALIDATED" | "INVALIDATED"
  expectedUpdatedAt?: string
}) {
  const prisma = getPrisma()

  const existing = await prisma.assumption.findUnique({
    where: { id: assumptionId },
    select: { id: true, title: true, updatedAt: true },
  })
  if (!existing) {
    return fail(`Assumption "${assumptionId}" not found.`)
  }

  // Build update payload imperatively to satisfy Prisma's union type constraints
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = { updatedAt: new Date(Math.max(Date.now(), (existing.updatedAt?.getTime() ?? 0) + 1)) }
  if (title !== undefined) updateData.title = title.trim()
  if (description !== undefined) updateData.description = description?.trim() || null
  if (riskLevel !== undefined) updateData.riskLevel = riskLevel
  if (status !== undefined) updateData.status = status

  const mutate = (tx: AppTransactionClient) => tx.assumption.update({
    where: { id: assumptionId, ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {}), ...getToolExpectedWhere() },
    data: updateData,
  })
  // Interview edits do not accept status, and must retain their owning transaction.
  const updated = status === undefined ? await mutate(prisma) : await captureWorkspaceMutation(getDatabase(), "assumption", "update", "MCP", assumptionId, mutate)

  return ok(
    `**Assumption updated**\n` +
      `ID: ${updated.id}\n` +
      `Title: ${updated.title}\n` +
      `Description: ${updated.description ?? "(none)"}\n` +
      `Risk: ${updated.riskLevel}\n` +
      `Status: ${updated.status}`,
    {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      riskLevel: updated.riskLevel,
      status: updated.status,
    }
  )
}

// ── delete_assumption ────────────────────────────────────────────────────────

export async function deleteAssumption({ assumptionId }: { assumptionId: string }) {
  const prisma = getPrisma()

  const existing = await prisma.assumption.findUnique({
    where: { id: assumptionId },
    select: { id: true, title: true },
  })
  if (!existing) {
    return fail(`Assumption "${assumptionId}" not found.`)
  }

  // Null out references before deleting — Aurora DSQL has relationMode = "prisma"
  // (no real FK constraints, no cascade deletes). Mirrors the established
  // deleteSquad pattern in app/[orgSlug]/[workspaceSlug]/settings/actions.ts.
  await prisma.experiment.updateMany({ where: { assumptionId }, data: { assumptionId: null } })
  await prisma.evidence.updateMany({ where: { assumptionId }, data: { assumptionId: null } })

  await prisma.assumption.delete({ where: { id: assumptionId } })

  return ok(`**Assumption deleted**\nID: ${existing.id}\nTitle: ${existing.title}`, {
    id: existing.id,
    deleted: true,
  })
}
