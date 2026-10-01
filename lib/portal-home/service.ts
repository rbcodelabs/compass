import type { Prisma } from "@prisma/client"
import type { AppPrismaClient } from "@/lib/db"
import { layoutSchema, normalizeOrder, parseStoredWidgets, type PortalHomeWidget } from "./schema"

export { hasUnpublishedChanges } from "./schema"

export interface StoredHomeLayout {
  draft: PortalHomeWidget[]
  /** null until the first publish. */
  published: PortalHomeWidget[] | null
  publishedAt: Date | null
  hasRow: boolean
}

function toJson(widgets: readonly PortalHomeWidget[]): Prisma.InputJsonValue {
  // Round-trip through JSON so Prisma stores plain data (and strips undefined).
  return JSON.parse(JSON.stringify(widgets)) as Prisma.InputJsonValue
}

export async function loadHomeLayout(prisma: AppPrismaClient, workspaceId: string): Promise<StoredHomeLayout> {
  const row = await prisma.portalHomeLayout.findUnique({ where: { workspaceId } })
  if (!row) return { draft: [], published: null, publishedAt: null, hasRow: false }
  return {
    draft: parseStoredWidgets(row.draftWidgets),
    published: row.publishedWidgets === null ? null : parseStoredWidgets(row.publishedWidgets),
    publishedAt: row.publishedAt,
    hasRow: true,
  }
}

/** Customer read: published layout only, never the draft. */
export async function loadPublishedWidgets(prisma: AppPrismaClient, workspaceId: string): Promise<PortalHomeWidget[] | null> {
  const row = await prisma.portalHomeLayout.findUnique({
    where: { workspaceId },
    select: { publishedWidgets: true },
  })
  if (!row || row.publishedWidgets === null) return null
  return parseStoredWidgets(row.publishedWidgets)
}

/** Validates (throws ZodError) and saves the draft. Order is normalized to array order. */
export async function saveDraft(prisma: AppPrismaClient, workspaceId: string, input: unknown): Promise<PortalHomeWidget[]> {
  const widgets = normalizeOrder(layoutSchema.parse(input))
  const now = new Date()
  await prisma.portalHomeLayout.upsert({
    where: { workspaceId },
    create: { workspaceId, draftWidgets: toJson(widgets), createdAt: now, updatedAt: now },
    update: { draftWidgets: toJson(widgets), updatedAt: now },
  })
  return widgets
}

export class NothingToPublishError extends Error {
  constructor() {
    super("There is no draft to publish")
    this.name = "NothingToPublishError"
  }
}

/** Copies the stored draft to published. Re-validates strictly: a bad draft cannot reach customers. */
export async function publishDraft(prisma: AppPrismaClient, workspaceId: string, userId: string | null): Promise<{ published: PortalHomeWidget[]; publishedAt: Date }> {
  const row = await prisma.portalHomeLayout.findUnique({ where: { workspaceId }, select: { draftWidgets: true } })
  if (!row) throw new NothingToPublishError()
  const widgets = normalizeOrder(layoutSchema.parse(row.draftWidgets))
  const publishedAt = new Date()
  await prisma.portalHomeLayout.update({
    where: { workspaceId },
    data: { publishedWidgets: toJson(widgets), publishedAt, publishedById: userId, updatedAt: publishedAt },
  })
  return { published: widgets, publishedAt }
}
