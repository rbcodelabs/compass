/**
 * Handler functions for the three Feedback MCP tools.
 * Extracted into this module so they can be unit-tested without the MCP server layer.
 */

import getPrisma from "@/lib/db"

export async function getFeedbackItem({ feedbackId }: { feedbackId: string }) {
  const prisma = getPrisma()
  const item = await prisma.feedbackItem.findUnique({
    where: { id: feedbackId },
    include: { opportunity: { select: { id: true, title: true, status: true } } },
  })
  if (!item) {
    return { content: [{ type: "text" as const, text: `Feedback item "${feedbackId}" not found.` }] }
  }
  const lines = [
    `## ${item.title}`,
    `**ID:** ${item.id}`,
    `**Status:** ${item.status}`,
    `**Votes:** ${item.voteCount}`,
    `**Workspace ID:** ${item.workspaceId}`,
    item.submitterName ? `**Submitter:** ${item.submitterName}` : null,
    item.submitterEmail ? `**Email:** ${item.submitterEmail}` : null,
    item.description ? `\n**Description:**\n${item.description}` : null,
    item.tags ? `**Tags:** ${JSON.stringify(item.tags)}` : null,
    item.opportunityId ? `**Opportunity ID:** ${item.opportunityId}` : null,
    item.opportunity ? `**Linked Opportunity:** ${item.opportunity.title} [${item.opportunity.status}] (ID: ${item.opportunity.id})` : null,
    `**Created:** ${item.createdAt.toISOString()}`,
    `**Updated:** ${item.updatedAt.toISOString()}`,
  ].filter(Boolean)
  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

export async function updateFeedbackStatus({
  feedbackId,
  status,
  note,
}: {
  feedbackId: string
  status: "OPEN" | "UNDER_REVIEW" | "PLANNED" | "CLOSED"
  note?: string
}) {
  const prisma = getPrisma()
  const existing = await prisma.feedbackItem.findUnique({
    where: { id: feedbackId },
    select: { title: true, status: true },
  })
  if (!existing) {
    return { content: [{ type: "text" as const, text: `Feedback item "${feedbackId}" not found.` }] }
  }
  const oldStatus = existing.status
  await prisma.feedbackItem.update({
    where: { id: feedbackId },
    data: { status, updatedAt: new Date() },
  })
  const lines = [
    `**Status updated** for "${existing.title}"`,
    `${oldStatus} → ${status}`,
    note ? `Note: ${note}` : null,
  ].filter(Boolean)
  return { content: [{ type: "text" as const, text: lines.join("\n") }] }
}

export async function linkFeedbackToOpportunity({
  feedbackId,
  opportunityId,
}: {
  feedbackId: string
  opportunityId: string
}) {
  const prisma = getPrisma()
  const feedback = await prisma.feedbackItem.findUnique({
    where: { id: feedbackId },
    select: { id: true, title: true, workspaceId: true },
  })
  if (!feedback) {
    return { content: [{ type: "text" as const, text: `Feedback item "${feedbackId}" not found.` }] }
  }
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: { id: true, title: true, workspaceId: true },
  })
  if (!opportunity) {
    return { content: [{ type: "text" as const, text: `Opportunity "${opportunityId}" not found.` }] }
  }
  await prisma.feedbackItem.update({
    where: { id: feedbackId },
    data: { opportunityId },
  })
  return {
    content: [{
      type: "text" as const,
      text: `Linked feedback '${feedback.title}' to opportunity '${opportunity.title}'.`,
    }],
  }
}
