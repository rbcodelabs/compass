/**
 * Handler functions for the Feedback MCP tools.
 * Extracted into this module so they can be unit-tested without the MCP server layer.
 */

import getPrisma from "@/lib/db"
import { randomUUID } from "node:crypto"
import { validateFeedbackInput } from "@/lib/feedback"
import { ok, fail } from "@/lib/mcp-output"
import {
  deleteFeedbackBlobs,
  type FeedbackAttachmentMetadata,
  type InlineFeedbackAttachment,
  prepareFeedbackAttachmentUpload,
  uploadInlineFeedbackAttachments,
  verifyCompletedFeedbackUpload,
} from "@/lib/feedback-attachments"
import { feedbackItemUrl } from "@/lib/compass-url"
import type { FeedbackStatus } from "@/lib/feedback-meta"

type FeedbackWorkspace = {
  slug: string
  organization: { slug: string }
}

function canonicalFeedbackUrl(workspace: FeedbackWorkspace, feedbackId: string): string {
  return feedbackItemUrl({
    orgSlug: workspace.organization.slug,
    workspaceSlug: workspace.slug,
    feedbackId,
  })
}

const MAX_FEEDBACK_ATTACHMENTS = 5

function isSerializationConflict(error: unknown): boolean {
  const value = error as { code?: string; message?: string; meta?: { code?: string } }
  return value?.code === "40001" || value?.meta?.code === "40001" || /OC00\d|serialization/i.test(value?.message ?? "")
}

function createdFeedbackResult(
  item: Record<string, unknown> & { id: string; title: string; type: string; status: string },
  attachments: FeedbackAttachmentMetadata[],
  url: string,
) {
  return ok([
    "**Feedback item created**",
    `ID: ${item.id}`,
    `Title: ${item.title}`,
    `Type: ${item.type}`,
    `Status: ${item.status}`,
    `URL: ${url}`,
  ].join("\n"), { ...item, attachments, url })
}

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
  attachments,
}: {
  workspaceId: string
  title: string
  description?: string
  type?: "BUG" | "IDEA"
  submitterName?: string
  submitterEmail?: string
  attachments?: InlineFeedbackAttachment[]
}) {
  const prisma = getPrisma()

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, slug: true, organization: { select: { slug: true } } },
  })
  if (!workspace) {
    return fail(`No workspace found with id "${workspaceId}".`)
  }

  const validation = validateFeedbackInput({ title, description })
  if (!validation.valid) {
    return fail(validation.error)
  }

  const feedbackId = randomUUID()
  const url = canonicalFeedbackUrl(workspace, feedbackId)

  let uploadedAttachments = [] as Awaited<ReturnType<typeof uploadInlineFeedbackAttachments>>
  let createAttempted = false
  try {
    uploadedAttachments = attachments?.length
      ? await uploadInlineFeedbackAttachments(workspaceId, attachments)
      : []
    const attachmentRows = uploadedAttachments.map((attachment) => ({ id: randomUUID(), ...attachment }))
    createAttempted = true
    const item = await prisma.feedbackItem.create({
      data: {
        id: feedbackId,
        workspaceId,
        title: validation.data.title,
        description: validation.data.description,
        type: type ?? "IDEA",
        submitterName: submitterName?.trim() || null,
        submitterEmail: submitterEmail?.trim() || null,
        source: "MCP",
        ...(attachmentRows.length ? { attachments: { create: attachmentRows } } : {}),
      },
    })
    return createdFeedbackResult(item, uploadedAttachments, url)
  } catch (error) {
    if (createAttempted) {
      try {
        const committed = await prisma.feedbackItem.findUnique({ where: { id: feedbackId } })
        if (committed) return createdFeedbackResult(committed, uploadedAttachments, url)
        await deleteFeedbackBlobs(uploadedAttachments.map((attachment) => attachment.url))
      } catch {
        // Commit state is unknown. Preserve the Blob to avoid a dangling DB reference.
      }
    }
    return fail(error instanceof Error ? error.message : "Could not create feedback with attachments.")
  }
}

export async function getFeedbackItem({ feedbackId }: { feedbackId: string }) {
  const prisma = getPrisma()
  const item = await prisma.feedbackItem.findUnique({
    where: { id: feedbackId },
    include: {
      opportunity: { select: { id: true, title: true, status: true } },
      attachments: { select: { filename: true, url: true } },
      workspace: { select: { slug: true, organization: { select: { slug: true } } } },
    },
  })
  if (!item) {
    return fail(`Feedback item "${feedbackId}" not found.`)
  }
  const url = canonicalFeedbackUrl(item.workspace, item.id)
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
    `URL: ${url}`,
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
    url,
  })
}

export async function listFeedback({
  workspaceId,
  status,
  limit,
}: {
  workspaceId: string
  status?: FeedbackStatus | "CLOSED"
  limit?: number
}) {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, slug: true, organization: { select: { slug: true } } },
  })
  if (!workspace) return fail(`No workspace found with id "${workspaceId}".`)
  const items = await prisma.feedbackItem.findMany({
    where: { workspaceId, ...(status ? { status } : {}) },
    include: { opportunity: { select: { title: true } } },
    orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
    take: limit ?? 50,
  })
  if (!items.length) return fail("No feedback found.")
  const withUrls = items.map((item) => ({
    item,
    url: canonicalFeedbackUrl(workspace, item.id),
  }))
  const lines = withUrls.map(({ item, url }) =>
    `• [${item.type}] **${item.title}** [${item.status}] 👍 ${item.voteCount}\n` +
    `  ID: ${item.id}\n` +
    `  URL: ${url}\n` +
    (item.description ? `  ${item.description.slice(0, 100)}${item.description.length > 100 ? "…" : ""}\n` : "") +
    (item.opportunity ? `  → Linked opportunity: ${item.opportunity.title}\n` : "") +
    (item.submitterName ? `  Submitted by: ${item.submitterName}` : "")
  )
  return ok(lines.join("\n\n"), {
    items: withUrls.map(({ item, url }) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      status: item.status,
      voteCount: item.voteCount,
      description: item.description,
      opportunity: item.opportunity?.title ?? null,
      submitterName: item.submitterName,
      url,
    })),
    count: items.length,
  })
}

export async function updateFeedback({
  feedbackId,
  title,
  description,
}: {
  feedbackId: string
  title?: string
  description?: string | null
}) {
  if (title === undefined && description === undefined) {
    return fail("Provide title and/or description.")
  }
  const prisma = getPrisma()
  const existing = await prisma.feedbackItem.findUnique({
    where: { id: feedbackId },
    select: {
      id: true,
      title: true,
      description: true,
      workspace: { select: { slug: true, organization: { select: { slug: true } } } },
    },
  })
  if (!existing) return fail(`Feedback item "${feedbackId}" not found.`)
  const url = canonicalFeedbackUrl(existing.workspace, feedbackId)
  const validation = validateFeedbackInput({
    title: title ?? existing.title,
    description: description === undefined ? existing.description : description,
  })
  if (!validation.valid) return fail(validation.error)
  const data: { title?: string; description?: string | null; updatedAt: Date } = { updatedAt: new Date() }
  if (title !== undefined) data.title = validation.data.title
  if (description !== undefined) data.description = validation.data.description
  const item = await prisma.feedbackItem.update({
    where: { id: feedbackId },
    data,
    select: { id: true, title: true, description: true },
  })
  return ok(
    [`**Feedback updated**`, `ID: ${feedbackId}`, `Title: ${item.title}`, `URL: ${url}`].join("\n"),
    { ...item, url },
  )
}

export async function updateFeedbackStatus({
  feedbackId,
  status,
  note,
}: {
  feedbackId: string
  status: FeedbackStatus | "CLOSED"
  note?: string
}) {
  const prisma = getPrisma()
  const existing = await prisma.feedbackItem.findUnique({
    where: { id: feedbackId },
    select: {
      id: true,
      title: true,
      status: true,
      workspace: { select: { slug: true, organization: { select: { slug: true } } } },
    },
  })
  if (!existing) {
    return fail(`Feedback item "${feedbackId}" not found.`)
  }
  const url = canonicalFeedbackUrl(existing.workspace, feedbackId)
  const oldStatus = existing.status
  await prisma.feedbackItem.update({
    where: { id: feedbackId },
    data: { status, updatedAt: new Date() },
  })
  const lines = [
    `**Status updated** for "${existing.title}"`,
    `${oldStatus} → ${status}`,
    note ? `Note: ${note}` : null,
    `ID: ${feedbackId}`,
    `URL: ${url}`,
  ].filter(Boolean)
  return ok(lines.join("\n"), {
    id: feedbackId,
    title: existing.title,
    oldStatus,
    status,
    note: note ?? null,
    url,
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
    select: {
      id: true,
      title: true,
      workspaceId: true,
      workspace: { select: { slug: true, organization: { select: { slug: true } } } },
    },
  })
  if (!feedback) {
    return fail(`Feedback item "${feedbackId}" not found.`)
  }
  const url = canonicalFeedbackUrl(feedback.workspace, feedback.id)
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: { id: true, title: true, workspaceId: true },
  })
  if (!opportunity) {
    return fail(`Opportunity "${opportunityId}" not found.`)
  }
  await prisma.feedbackItem.update({
    where: { id: feedbackId },
    // Explicit `updatedAt`: DSQL has no trigger support, so the schema uses
    // `@default(now())` instead of `@updatedAt` and nothing bumps it for us.
    // The sibling status/type handlers already do this; this one was missed.
    data: { opportunityId, updatedAt: new Date() },
  })
  return ok([
    `Linked feedback '${feedback.title}' to opportunity '${opportunity.title}'.`,
    `ID: ${feedback.id}`,
    `URL: ${url}`,
  ].join("\n"), {
    id: feedback.id,
    title: feedback.title,
    workspaceId: feedback.workspaceId,
    opportunityId: opportunity.id,
    opportunityTitle: opportunity.title,
    url,
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
    select: {
      id: true,
      title: true,
      type: true,
      workspace: { select: { slug: true, organization: { select: { slug: true } } } },
    },
  })
  if (!existing) {
    return fail(`Feedback item "${feedbackId}" not found.`)
  }
  const url = canonicalFeedbackUrl(existing.workspace, existing.id)
  const oldType = existing.type
  await prisma.feedbackItem.update({
    where: { id: feedbackId },
    data: { type, updatedAt: new Date() },
  })
  const lines = [
    `**Type updated** for "${existing.title}"`,
    `${oldType} → ${type}`,
    `ID: ${existing.id}`,
    `URL: ${url}`,
  ]
  return ok(lines.join("\n"), {
    id: existing.id,
    title: existing.title,
    oldType,
    type,
    url,
  })
}

export async function prepareFeedbackAttachmentUploadTool(input: {
  workspaceId: string
  filename: string
  fileType: string
  fileSize: number
}) {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { id: true } })
  if (!workspace) return fail(`No workspace found with id "${input.workspaceId}".`)
  try {
    const prepared = await prepareFeedbackAttachmentUpload(input)
    return ok(
      [
        "**Direct upload prepared**",
        `Pathname: ${prepared.pathname}`,
        `Expires: ${new Date(prepared.expiresAt).toISOString()}`,
        "Upload with @vercel/blob/client put(pathname, file, { access: \"public\", token: clientToken, contentType: fileType }), then call add_feedback_attachment with the returned Blob URL and receipt.",
      ].join("\n"),
      prepared,
    )
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not prepare feedback attachment upload.")
  }
}

function attachmentResultText(input: {
  attachment: { id: string; filename: string; url: string }
  feedbackUrl: string
  alreadyAttached?: boolean
}): string {
  return [
    input.alreadyAttached ? "**Attachment already attached**" : "**Feedback attachment added**",
    `ID: ${input.attachment.id}`,
    `Filename: ${input.attachment.filename}`,
    `Attachment URL: ${input.attachment.url}`,
    `URL: ${input.feedbackUrl}`,
  ].join("\n")
}

export async function addFeedbackAttachment({
  feedbackId,
  inline,
  uploaded,
}: {
  feedbackId: string
  inline?: InlineFeedbackAttachment
  uploaded?: { url: string; receipt: string }
}) {
  if ((inline ? 1 : 0) + (uploaded ? 1 : 0) !== 1) {
    return fail("Provide exactly one inline or uploaded attachment.")
  }
  const prisma = getPrisma()
  const feedback = await prisma.feedbackItem.findUnique({
    where: { id: feedbackId },
    select: {
      id: true,
      workspaceId: true,
      workspace: { select: { slug: true, organization: { select: { slug: true } } } },
    },
  })
  if (!feedback) return fail(`Feedback item "${feedbackId}" not found.`)
  const feedbackUrl = canonicalFeedbackUrl(feedback.workspace, feedbackId)

  let metadata: FeedbackAttachmentMetadata | undefined
  let attachmentId: string = randomUUID()
  try {
    if (uploaded) {
      const completed = await verifyCompletedFeedbackUpload({
          workspaceId: feedback.workspaceId,
          url: uploaded.url,
          receipt: uploaded.receipt,
        })
      attachmentId = completed.attachmentId
      metadata = completed
    }

    // Touching the parent makes every concurrent addition conflict on the same
    // row in DSQL's OCC model (and serialize on local PostgreSQL) before count.
    await prisma.$transaction(async (tx) => {
      await tx.feedbackItem.update({ where: { id: feedbackId }, data: { updatedAt: new Date() }, select: { id: true } })
      const count = await tx.feedbackAttachment.count({ where: { feedbackItemId: feedbackId } })
      if (count >= MAX_FEEDBACK_ATTACHMENTS) throw new Error(`Feedback supports a maximum of ${MAX_FEEDBACK_ATTACHMENTS} attachments.`)
    })

    if (inline) metadata = (await uploadInlineFeedbackAttachments(feedback.workspaceId, [inline]))[0]

    const outcome = await prisma.$transaction(async (tx) => {
      await tx.feedbackItem.update({ where: { id: feedbackId }, data: { updatedAt: new Date() }, select: { id: true } })
      const existing = await tx.feedbackAttachment.findFirst({
        where: { OR: [{ id: attachmentId }, { url: metadata!.url }] },
      })
      if (existing) {
        const sameAttachment = existing.feedbackItemId === feedbackId && existing.url === metadata!.url
        return { attachment: existing, status: sameAttachment ? "existing" as const : "conflict" as const }
      }
      const count = await tx.feedbackAttachment.count({ where: { feedbackItemId: feedbackId } })
      if (count >= MAX_FEEDBACK_ATTACHMENTS) throw new Error(`Feedback supports a maximum of ${MAX_FEEDBACK_ATTACHMENTS} attachments.`)
      const attachment = await tx.feedbackAttachment.create({
        data: {
          id: attachmentId,
          feedbackItemId: feedbackId,
          url: metadata!.url,
          filename: metadata!.filename,
          fileType: metadata!.fileType,
          fileSize: metadata!.fileSize,
        },
      })
      return { attachment, status: "created" as const }
    })
    if (outcome.status === "conflict") return fail("This uploaded blob already belongs to another feedback item.")
    const alreadyAttached = outcome.status === "existing"
    return ok(attachmentResultText({ attachment: outcome.attachment, feedbackUrl, alreadyAttached }), {
      ...outcome.attachment,
      feedbackUrl,
      alreadyAttached,
    })
  } catch (error) {
    const serializationConflict = isSerializationConflict(error)
    if (metadata) {
      try {
        const winner = await prisma.feedbackAttachment.findUnique({ where: { id: attachmentId } })
        if (winner?.feedbackItemId === feedbackId && winner.url === metadata.url) {
          return ok(attachmentResultText({ attachment: winner, feedbackUrl, alreadyAttached: true }), {
            ...winner,
            feedbackUrl,
            alreadyAttached: true,
          })
        }
        if (winner) return fail("This upload receipt already belongs to another feedback item.")
        if (!uploaded || !serializationConflict) await deleteFeedbackBlobs([metadata.url])
      } catch {
        // Commit state is unknown. Preserve the Blob to avoid a dangling DB reference.
      }
    }
    if (serializationConflict) {
      return fail("Attachment update conflicted with another request; retry this operation.")
    }
    return fail(error instanceof Error ? error.message : "Could not add feedback attachment.")
  }
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
