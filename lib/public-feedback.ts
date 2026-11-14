/**
 * THE public-feedback predicate and shape. Every query that puts feedback in
 * front of a customer audience (portal feedback page, portal feedback API,
 * portal-home widgets, public votes) must start from `publicFeedbackItemWhere`
 * and select via `PUBLIC_FEEDBACK_SELECT`, the same way roadmap surfaces start
 * from `publicRoadmapItemWhere`. Callers must also require
 * `workspace.feedbackEnabled` before querying at all.
 *
 * Design: filter by SOURCE (allow-list, PORTAL only; add a source here only
 * together with a real writer), not by a new column. Items logged
 * internally (app UI, MCP, REST API, meta-feedback) carry another source and are
 * never public. Allow-list, so a new internal source is private by default.
 * Pre-existing portal submissions were written with the column default ("UI")
 * and are indistinguishable from internal rows, so they fail closed (hidden).
 */

export const PUBLIC_FEEDBACK_SOURCES = ["PORTAL"] as const

/** Source stamped on feedback submitted through the public portal. */
export const PORTAL_FEEDBACK_SOURCE = "PORTAL"

export function publicFeedbackItemWhere(workspaceId: string) {
  return {
    workspaceId,
    source: { in: [...PUBLIC_FEEDBACK_SOURCES] },
    status: { not: "DECLINED" },
  }
}

/** The only columns a customer-audience surface may read. No emails, no
 * opportunity link, no internal comments/notes, no tags, no actor ids. */
export const PUBLIC_FEEDBACK_SELECT = {
  id: true,
  title: true,
  description: true,
  type: true,
  status: true,
  voteCount: true,
  submitterName: true,
  createdAt: true,
  attachments: { select: { id: true, url: true, filename: true, fileType: true } },
} as const

export type PublicFeedbackRow = {
  id: string
  title: string
  description: string | null
  type: string
  status: string
  voteCount: number
  submitterName: string | null
  createdAt: Date
  attachments: { id: string; url: string; filename: string; fileType: string }[]
}

/** Explicit field copy (not a spread), so a widened select can never leak. */
export function serializePublicFeedbackItem(item: PublicFeedbackRow) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    type: item.type,
    status: item.status,
    voteCount: item.voteCount,
    submitterName: item.submitterName,
    createdAt: item.createdAt.toISOString(),
    attachments: item.attachments.map((a) => ({ id: a.id, url: a.url, filename: a.filename, fileType: a.fileType })),
  }
}
