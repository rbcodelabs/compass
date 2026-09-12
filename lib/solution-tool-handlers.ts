/**
 * Handler functions for Solution MCP tools (update_solution).
 * Extracted into this module so it can be unit-tested without the MCP server layer.
 * Mirrors the updateAssumption pattern in lib/assumption-tool-handlers.ts.
 */

import getPrisma from "@/lib/db"
import { ok, fail } from "@/lib/mcp-output"

// ── update_solution ──────────────────────────────────────────────────────────

export async function updateSolution({
  solutionId,
  title,
  description,
}: {
  solutionId: string
  title?: string
  description?: string
}) {
  const prisma = getPrisma()

  const existing = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: { id: true, title: true, description: true },
  })
  if (!existing) {
    return fail(`Solution "${solutionId}" not found.`)
  }

  if (title === undefined && description === undefined) {
    return fail("At least one of title or description must be provided.")
  }

  // Build update payload imperatively to satisfy Prisma's union type constraints
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = { updatedAt: new Date() }
  if (title !== undefined) updateData.title = title.trim()
  // Empty string is a valid "clear the description" value — only `undefined`
  // means "not provided", so don't special-case "" here.
  if (description !== undefined) updateData.description = description.trim()

  const updated = await prisma.solution.update({
    where: { id: solutionId },
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
