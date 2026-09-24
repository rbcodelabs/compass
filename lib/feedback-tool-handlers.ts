/**
 * Handler functions for the Feedback MCP tools.
 * Extracted into this module so they can be unit-tested without the MCP server layer.
 */

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import getPrisma from "@/lib/db"
import { randomUUID } from "node:crypto"
import { z } from "zod"
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
import { CompassUrlNotConfiguredError, feedbackItemUrl, safeEntityUrl, withUrlLine } from "@/lib/compass-url"
import { FEEDBACK_STATUSES, type FeedbackStatus } from "@/lib/feedback-meta"

const feedbackCursorSchema = z.object({
  v: z.literal(1),
  workspaceId: z.string().min(1),
  status: z.enum([...FEEDBACK_STATUSES, "CLOSED"]).nullable(),
  updatedSince: z.string().datetime(),
  asOf: z.string().datetime(),
  afterUpdatedAt: z.string().datetime(),
  afterId: z.string().min(1),
}).strict()

type FeedbackWorkspace = {
  slug: string
  organization: { slug: string }
}

/**
 * The FeedbackItem is always created/updated in the database regardless of
 * whether a human-facing link can be built, so a *missing* URL config
 * degrades to `null` here rather than failing the whole MCP tool call —
 * mirroring `buildReviewUrl` in lib/decision-tool-handlers.ts. An unsafe
 * *configured* origin (bad protocol, credentials, malformed URL) is a
 * different and more serious failure: it still aborts the mutation, matching
 * the pre-existing "feedback mutation safety" contract below.
 */
function canonicalFeedbackUrl(workspace: FeedbackWorkspace, feedbackId: string): string | null {
  try {
    return feedbackItemUrl({
      orgSlug: workspace.organization.slug,
      workspaceSlug: workspace.slug,
      feedbackId,
    })
  } catch (error) {
    if (error instanceof CompassUrlNotConfiguredError) return null
    throw error
  }
}

const MAX_FEEDBACK_ATTACHMENTS = 5

function isSerializationConflict(error: unknown): boolean {
  const value = error as { code?: string; message?: string; meta?: { code?: string } }
  return value?.code === "40001" || value?.meta?.code === "40001" || /OC00\d|serialization/i.test(value?.message ?? "")
}

function createdFeedbackResult(
  item: Record<string, unknown> & { id: string; title: string; type: string; status: string },
  attachments: FeedbackAttachmentMetadata[],
  url: string | null,
) {
  return ok(withUrlLine([
    "**Feedback item created**",
    `ID: ${item.id}`,
    `Title: ${item.title}`,
    `Type: ${item.type}`,
    `Status: ${item.status}`,
  ].join("\n"), url), { ...item, attachments, url })
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
    url ? `URL: ${url}` : null,
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
  updatedSince,
  cursor,
}: {
  workspaceId: string
  status?: FeedbackStatus | "CLOSED"
  limit?: number
  updatedSince?: string
  cursor?: string
}) {
  if (updatedSince !== undefined && cursor !== undefined) {
    return fail("Provide either updatedSince or cursor, not both.")
  }

  const normalizedStatus = status ?? null
  let decodedCursor: z.infer<typeof feedbackCursorSchema> | null = null
  if (cursor !== undefined) {
    try {
      decodedCursor = feedbackCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
    } catch {
      return fail("Invalid feedback cursor.")
    }
    if (decodedCursor.workspaceId !== workspaceId || decodedCursor.status !== normalizedStatus) {
      return fail("Feedback cursor does not match the requested workspace or status.")
    }
  }

  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, slug: true, organization: { select: { slug: true } } },
  })
  if (!workspace) return fail(`No workspace found with id "${workspaceId}".`)
  const scanMode = updatedSince !== undefined || cursor !== undefined
  let scan: {
    updatedSince: Date
    asOf: Date
    after?: { updatedAt: Date; id: string }
  } | null = null
  if (scanMode) {
    try {
      if (decodedCursor) {
        scan = {
          updatedSince: new Date(decodedCursor.updatedSince),
          asOf: new Date(decodedCursor.asOf),
          after: { updatedAt: new Date(decodedCursor.afterUpdatedAt), id: decodedCursor.afterId },
        }
      } else {
        scan = { updatedSince: new Date(updatedSince!), asOf: new Date() }
      }
      if (Number.isNaN(scan.updatedSince.getTime()) || Number.isNaN(scan.asOf.getTime()) ||
          (scan.after && Number.isNaN(scan.after.updatedAt.getTime()))) {
        throw new Error("Invalid feedback cursor dates")
      }
      if (scan.updatedSince > scan.asOf ||
          (scan.after && (scan.after.updatedAt < scan.updatedSince || scan.after.updatedAt > scan.asOf))) {
        throw new Error("Invalid feedback cursor bounds")
      }
    } catch {
      return fail("Invalid feedback cursor.")
    }
  }
  const resolvedLimit = limit ?? 50
  const scanBounds = scan
    ? [
        { updatedAt: { gte: scan.updatedSince, lte: scan.asOf } },
        ...(scan.after
          ? [{
              OR: [
                { updatedAt: { gt: scan.after.updatedAt } },
                { updatedAt: scan.after.updatedAt, id: { gt: scan.after.id } },
              ],
            }]
          : []),
      ]
    : undefined
  const items = await prisma.feedbackItem.findMany({
    where: {
      workspaceId,
      ...(status ? { status } : {}),
      ...(scanBounds ? { AND: scanBounds } : {}),
    },
    include: { opportunity: { select: { id: true, title: true } } },
    orderBy: scan
      ? [{ updatedAt: "asc" as const }, { id: "asc" as const }]
      : [{ voteCount: "desc" as const }, { createdAt: "desc" as const }, { id: "asc" as const }],
    take: scan ? resolvedLimit + 1 : resolvedLimit,
  })
  if (!items.length && !scan) return fail("No feedback found.")
  const hasMore = scan ? items.length > resolvedLimit : false
  const pageItems = hasMore ? items.slice(0, resolvedLimit) : items
  const withUrls = pageItems.map((item) => ({
    item,
    url: canonicalFeedbackUrl(workspace, item.id),
  }))
  const lines = withUrls.map(({ item, url }) =>
    `• [${item.type}] **${item.title}** [${item.status}] 👍 ${item.voteCount}\n` +
    `  ID: ${item.id}\n` +
    (url ? `  URL: ${url}\n` : "") +
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
      opportunityId: item.opportunityId,
      opportunity: item.opportunity?.title ?? null,
      submitterName: item.submitterName,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      url,
    })),
    count: pageItems.length,
    ...(scan
      ? {
          hasMore,
          nextCursor: hasMore
            ? Buffer.from(JSON.stringify({
                v: 1,
                workspaceId,
                status: normalizedStatus,
                updatedSince: scan.updatedSince.toISOString(),
                asOf: scan.asOf.toISOString(),
                afterUpdatedAt: pageItems.at(-1)!.updatedAt.toISOString(),
                afterId: pageItems.at(-1)!.id,
              })).toString("base64url")
            : null,
          asOf: scan.asOf.toISOString(),
        }
      : {}),
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
    withUrlLine([`**Feedback updated**`, `ID: ${feedbackId}`, `Title: ${item.title}`].join("\n"), url),
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
    url ? `URL: ${url}` : null,
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
  return ok(withUrlLine([
    `Linked feedback '${feedback.title}' to opportunity '${opportunity.title}'.`,
    `ID: ${feedback.id}`,
  ].join("\n"), url), {
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
  ]
  return ok(withUrlLine(lines.join("\n"), url), {
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
  feedbackUrl: string | null
  alreadyAttached?: boolean
}): string {
  return withUrlLine([
    input.alreadyAttached ? "**Attachment already attached**" : "**Feedback attachment added**",
    `ID: ${input.attachment.id}`,
    `Filename: ${input.attachment.filename}`,
    `Attachment URL: ${input.attachment.url}`,
  ].join("\n"), input.feedbackUrl)
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
    // The workspace slugs ride along on the lookup this handler already makes,
    // so the roadmap deeplink below costs no extra round trip.
    select: {
      id: true,
      title: true,
      type: true,
      workspaceId: true,
      workspace: { select: { slug: true, organization: { select: { slug: true } } } },
    },
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

  const item = await captureWorkspaceMutation(prisma, "roadmapItem", "create", "MCP", undefined, tx => tx.roadmapItem.create({ data: {
      workspaceId,
      title: feedback.title,
      horizon,
      sortOrder,
      feedbackId,
      isPrivate: isPrivate ?? false,
    } }))

  const lines = [
    `**Promoted to roadmap (${horizon})**`,
    `ID: ${item.id}`,
    `Title: ${item.title}`,
    ...(item.isPrivate ? [`Private: yes (hidden from public portal)`] : []),
    `Linked Feedback: ${feedback.title} [${feedback.type}]`,
  ]
  // The roadmap item is created in `workspaceId`, which need not be the
  // feedback's own workspace — only link when the slugs we have describe the
  // workspace the item actually landed in.
  const url = feedback.workspaceId === workspaceId
    ? safeEntityUrl({
        orgSlug: feedback.workspace?.organization?.slug,
        workspaceSlug: feedback.workspace?.slug,
        type: "roadmapItem",
        id: item.id,
      })
    : null
  return ok(withUrlLine(lines.join("\n"), url), {
    id: item.id,
    title: item.title,
    horizon,
    sortOrder: item.sortOrder,
    isPrivate: item.isPrivate,
    workspaceId: item.workspaceId,
    feedbackId,
  })
}
