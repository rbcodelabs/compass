/** Handler functions for Opportunity MCP tools. */

import getPrisma from "@/lib/db"
import { fail, ok } from "@/lib/mcp-output"
import { z } from "zod"

type UpdateOpportunityInput = {
  opportunityId: string
  title?: string
  description?: string | null
}

export async function updateOpportunity({
  opportunityId,
  title,
  description,
}: UpdateOpportunityInput) {
  if (!z.string().uuid().safeParse(opportunityId).success) {
    return fail("A valid opportunity ID is required.")
  }
  if (title === undefined && description === undefined) {
    return fail("Provide at least one editable field: title or description.")
  }

  const normalizedTitle = title?.trim()
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
    select: { id: true, title: true, description: true, status: true },
  })
  if (!existing) return fail(`Opportunity "${opportunityId}" not found.`)

  const data: {
    updatedAt: Date
    title?: string
    description?: string | null
  } = { updatedAt: new Date() }
  if (normalizedTitle !== undefined && normalizedTitle !== existing.title) {
    data.title = normalizedTitle
  }
  if (normalizedDescription !== undefined && normalizedDescription !== existing.description) {
    data.description = normalizedDescription
  }

  if (!("title" in data) && !("description" in data)) {
    return fail("No editable changes were provided.")
  }

  const updated = await prisma.opportunity.update({
    where: { id: opportunityId },
    data,
    select: { id: true, title: true, description: true, status: true },
  })

  return ok(
    `**Opportunity updated**\nID: ${updated.id}\nTitle: ${updated.title}\nStatus: ${updated.status}`,
    {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      status: updated.status,
    },
  )
}
