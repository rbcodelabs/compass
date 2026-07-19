/**
 * Handler functions for Assumption MCP tools (update_assumption, delete_assumption).
 * Extracted into this module so they can be unit-tested without the MCP server layer.
 * Mirrors the add_assumption tool (still inline in app/api/mcp/route.ts).
 */

import getPrisma from "@/lib/db"

// ── update_assumption ───────────────────────────────────────────────────────

export async function updateAssumption({
  assumptionId,
  title,
  riskLevel,
  status,
}: {
  assumptionId: string
  title?: string
  riskLevel?: "HIGH" | "MEDIUM" | "LOW"
  status?: "UNTESTED" | "TESTING" | "VALIDATED" | "INVALIDATED"
}) {
  const prisma = getPrisma()

  const existing = await prisma.assumption.findUnique({
    where: { id: assumptionId },
    select: { id: true, title: true },
  })
  if (!existing) {
    return {
      content: [{ type: "text" as const, text: `Assumption "${assumptionId}" not found.` }],
    }
  }

  // Build update payload imperatively to satisfy Prisma's union type constraints
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = { updatedAt: new Date() }
  if (title !== undefined) updateData.title = title.trim()
  if (riskLevel !== undefined) updateData.riskLevel = riskLevel
  if (status !== undefined) updateData.status = status

  const updated = await prisma.assumption.update({
    where: { id: assumptionId },
    data: updateData,
  })

  return {
    content: [
      {
        type: "text" as const,
        text:
          `**Assumption updated**\n` +
          `ID: ${updated.id}\n` +
          `Title: ${updated.title}\n` +
          `Risk: ${updated.riskLevel}\n` +
          `Status: ${updated.status}`,
      },
    ],
  }
}

// ── delete_assumption ────────────────────────────────────────────────────────

export async function deleteAssumption({ assumptionId }: { assumptionId: string }) {
  const prisma = getPrisma()

  const existing = await prisma.assumption.findUnique({
    where: { id: assumptionId },
    select: { id: true, title: true },
  })
  if (!existing) {
    return {
      content: [{ type: "text" as const, text: `Assumption "${assumptionId}" not found.` }],
    }
  }

  // Null out references before deleting — Aurora DSQL has relationMode = "prisma"
  // (no real FK constraints, no cascade deletes). Mirrors the established
  // deleteSquad pattern in app/[orgSlug]/[workspaceSlug]/settings/actions.ts.
  await prisma.experiment.updateMany({ where: { assumptionId }, data: { assumptionId: null } })
  await prisma.evidence.updateMany({ where: { assumptionId }, data: { assumptionId: null } })

  await prisma.assumption.delete({ where: { id: assumptionId } })

  return {
    content: [
      {
        type: "text" as const,
        text: `**Assumption deleted**\nID: ${existing.id}\nTitle: ${existing.title}`,
      },
    ],
  }
}
