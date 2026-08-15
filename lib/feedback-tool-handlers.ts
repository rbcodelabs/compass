/**
 * Handler functions for the Feedback MCP tools.
 * Extracted into this module so they can be unit-tested without the MCP server layer.
 */

import getPrisma from "@/lib/db"
import { validateFeedbackInput } from "@/lib/feedback"
import { ok, fail } from "@/lib/mcp-output"

/**
 * Creates a FeedbackItem directly via MCP — the internal/agent-facing
 * counterpart to the public portal submission endpoint (POST
 * /api/portal/{org}/{workspace}/feedback), which requires a browser session.
 * Reuses the same title/description validation as the in-app "New Feedback"
 * dialog. Marked source: "MCP" (see migration 016) to distinguish it from
 * UI- and portal-submitted feedback.
 */
export async function createFeedback({
  workspaceId,
  title,
  description,
  type,
  submitterName,
  submitterEmail,
}: {
  workspaceId: string
  title: string
  description?: string
  type?: "BUG" | "IDEA"
  submitterName?: string
  submitterEmail?: string
}) {
  const prisma = getPrisma()

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true },
  })
  if (!workspace) {
    return fail(`No workspace found with id "${workspaceId}".`)
  }

  const validation = validateFeedbackInput({ title, description })
  if (!validation.valid) {
    return fail(validation.error)
  }

  const item = await prisma.feedbackItem.create({
    data: {
      workspaceId,
      title: validation.data.title,
      description: validation.data.description,
      type: type ?? "IDEA",
      submitterName: submitterName?.trim() || null,
      submitterEmail: submitterEmail?.trim() || null,
      source: "MCP",
    },
  })

  const lines = [
    `**Feedback item created**`,
    `ID: ${item.id}`,
    `Title: ${item.title}`,
    `Type: ${item.type}`,
    `Status: ${item.status}`,
  ]
  return ok(lines.join("\n"), {
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    workspaceId: item.workspaceId,
    description: item.description,
    submitterName: item.submitterName,
    submitterEmail: item.submitterEmail,
    source: item.source,
    createdAt: item.createdAt,
  })
}

export async function getFeedbackItem({ feedbackId }: { feedbackId: string }) {
  const prisma = getPrisma()
  const item = await prisma.feedbackItem.findUnique({
    where: { id: feedbackId },
    include: {
      opportunity: { select: { id: true, title: true, status: true } },
      attachments: { select: { filename: true, url: true } },
    },
  })
  if (!item) {
    return fail(`Feedback item "${feedbackId}" not found.`)
  }
  const lines = [
    `## [${item.type}] ${item.title}`,
    `**ID:** ${item.id}`,
    `**Type:** ${item.type}`,
    `**Status:** ${item.status}`,
    `**Votes:** ${item.voteCount}`,
    `**Workspace ID:** ${item.workspaceId}`,
    item.submitterName ? `**Submitter:** ${item.submitterName}` : null,
    item.submitterEmail ? `**Email:** ${item.submitterEmail}` : null,
    item.description ? `\n**Description:**\n${item.description}` : null,
    item.tags ? `**Tags:** ${JSON.stringify(item.tags)}` : null,
    item.opportunityId ? `**Opportunity ID:** ${item.opportunityId}` : null,
    item.opportunity ? `**Linked Opportunity:** ${item.opportunity.title} [${item.opportunity.status}] (ID: ${item.opportunity.id})` : null,
    ...item.attachments.map((a) => `Attachments: ${a.filename} (${a.url})`),
    `**Created:** ${item.createdAt.toISOString()}`,
    `**Updated:** ${item.updatedAt.toISOString()}`,
  ].filter(Boolean)
  return ok(lines.join("\n"), {
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    voteCount: item.voteCount,
    workspaceId: item.workspaceId,
    description: item.description,
    submitterName: item.submitterName,
    submitterEmail: item.submitterEmail,
    tags: item.tags,
    opportunityId: item.opportunityId,
    opportunity: item.opportunity,
    attachments: item.attachments,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  })
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
    return fail(`Feedback item "${feedbackId}" not found.`)
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
  return ok(lines.join("\n"), {
    id: feedbackId,
    title: existing.title,
    oldStatus,
    status,
    note: note ?? null,
  })
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
    return fail(`Feedback item "${feedbackId}" not found.`)
  }
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: { id: true, title: true, workspaceId: true },
  })
  if (!opportunity) {
    return fail(`Opportunity "${opportunityId}" not found.`)
  }
  await prisma.feedbackItem.update({
    where: { id: feedbackId },
    data: { opportunityId },
  })
  return ok(`Linked feedback '${feedback.title}' to opportunity '${opportunity.title}'.`, {
    id: feedback.id,
    title: feedback.title,
    workspaceId: feedback.workspaceId,
    opportunityId: opportunity.id,
    opportunityTitle: opportunity.title,
  })
}

export async function updateFeedbackType({
  feedbackId,
  type,
}: {
  feedbackId: string
  type: "BUG" | "IDEA"
}) {
  const prisma = getPrisma()
  const existing = await prisma.feedbackItem.findUnique({
    where: { id: feedbackId },
    select: { id: true, title: true, type: true },
  })
  if (!existing) {
    return fail(`Feedback item "${feedbackId}" not found.`)
  }
  const oldType = existing.type
  await prisma.feedbackItem.update({
    where: { id: feedbackId },
    data: { type, updatedAt: new Date() },
  })
  const lines = [
    `**Type updated** for "${existing.title}"`,
    `${oldType} → ${type}`,
    `ID: ${existing.id}`,
  ]
  return ok(lines.join("\n"), {
    id: existing.id,
    title: existing.title,
    oldType,
    type,
  })
}

export async function promoteFeedbackToRoadmap({
  feedbackId,
  workspaceId,
  horizon,
  isPrivate,
}: {
  feedbackId: string
  workspaceId: string
  horizon: "NOW" | "NEXT" | "LATER" | "SHIPPED"
  isPrivate?: boolean
}) {
  const prisma = getPrisma()
  const feedback = await prisma.feedbackItem.findUnique({
    where: { id: feedbackId },
    select: { id: true, title: true, type: true },
  })
  if (!feedback) {
    return fail(`Feedback item "${feedbackId}" not found.`)
  }

  const lastItem = await prisma.roadmapItem.findFirst({
    where: { workspaceId, horizon, status: "ACTIVE" },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  })
  const sortOrder = lastItem ? lastItem.sortOrder + 1 : 0

  const item = await prisma.roadmapItem.create({
    data: {
      workspaceId,
      title: feedback.title,
      horizon,
      sortOrder,
      feedbackId,
      isPrivate: isPrivate ?? false,
    },
  })

  const lines = [
    `**Promoted to roadmap (${horizon})**`,
    `ID: ${item.id}`,
    `Title: ${item.title}`,
    ...(item.isPrivate ? [`Private: yes (hidden from public portal)`] : []),
    `Linked Feedback: ${feedback.title} [${feedback.type}]`,
  ]
  return ok(lines.join("\n"), {
    id: item.id,
    title: item.title,
    horizon: item.horizon,
    sortOrder: item.sortOrder,
    isPrivate: item.isPrivate,
    workspaceId: item.workspaceId,
    feedbackId,
  })
}
