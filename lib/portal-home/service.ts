import { Prisma } from "@prisma/client"
import type { AppPrismaClient } from "@/lib/db"
import { isMissingColumnError } from "@/lib/db-missing-column"
import { layoutSchema, normalizeOrder, parseStoredWidgets, type PortalHomeWidget } from "./schema"
import { DEFAULT_PORTAL_TEMPLATE, coerceStoredTemplate, portalTemplateSchema, type PortalTemplate } from "./templates"

export { hasUnpublishedChanges } from "./schema"

export interface StoredHomeLayout {
  draft: PortalHomeWidget[]
  /** null until the first publish. */
  published: PortalHomeWidget[] | null
  publishedAt: Date | null
  hasRow: boolean
  /** The template being edited. "editorial" when never set. */
  draftTemplate: PortalTemplate
  /** The template customers see. "editorial" until the first publish (and for rows that predate migration 114). */
  publishedTemplate: PortalTemplate
}

function toJson(widgets: readonly PortalHomeWidget[]): Prisma.InputJsonValue {
  // Round-trip through JSON so Prisma stores plain data (and strips undefined).
  return JSON.parse(JSON.stringify(widgets)) as Prisma.InputJsonValue
}

/** Columns that exist without migration 114: the fallback read for a database that has not applied it yet. */
const PRE_TEMPLATE_SELECT = { draftWidgets: true, publishedWidgets: true, publishedAt: true } as const

export async function loadHomeLayout(prisma: AppPrismaClient, workspaceId: string): Promise<StoredHomeLayout> {
  let row: { draftWidgets: unknown; publishedWidgets: unknown; publishedAt: Date | null; draftTemplate?: string | null; publishedTemplate?: string | null } | null
  try {
    row = await prisma.portalHomeLayout.findUnique({ where: { workspaceId } })
  } catch (error) {
    // Migration 114 not applied yet: every layout is the editorial template.
    if (!isMissingColumnError(error)) throw error
    row = await prisma.portalHomeLayout.findUnique({ where: { workspaceId }, select: PRE_TEMPLATE_SELECT })
  }
  if (!row) {
    return { draft: [], published: null, publishedAt: null, hasRow: false, draftTemplate: DEFAULT_PORTAL_TEMPLATE, publishedTemplate: DEFAULT_PORTAL_TEMPLATE }
  }
  return {
    draft: parseStoredWidgets(row.draftWidgets),
    published: row.publishedWidgets === null ? null : parseStoredWidgets(row.publishedWidgets),
    publishedAt: row.publishedAt,
    hasRow: true,
    draftTemplate: coerceStoredTemplate(row.draftTemplate),
    publishedTemplate: coerceStoredTemplate(row.publishedTemplate),
  }
}

/** Customer read: published layout only, never the draft. */
export async function loadPublishedWidgets(prisma: AppPrismaClient, workspaceId: string): Promise<PortalHomeWidget[] | null> {
  return (await loadPublishedHome(prisma, workspaceId)).widgets
}

/** Customer read of the published layout AND its template (never the draft's). widgets is null until the first publish. */
export async function loadPublishedHome(
  prisma: AppPrismaClient,
  workspaceId: string,
): Promise<{ widgets: PortalHomeWidget[] | null; template: PortalTemplate }> {
  let row: { publishedWidgets: unknown; publishedTemplate?: string | null } | null
  try {
    row = await prisma.portalHomeLayout.findUnique({ where: { workspaceId }, select: { publishedWidgets: true, publishedTemplate: true } })
  } catch (error) {
    if (!isMissingColumnError(error)) throw error
    row = await prisma.portalHomeLayout.findUnique({ where: { workspaceId }, select: { publishedWidgets: true } })
  }
  if (!row || row.publishedWidgets === null) return { widgets: null, template: DEFAULT_PORTAL_TEMPLATE }
  return { widgets: parseStoredWidgets(row.publishedWidgets), template: coerceStoredTemplate(row.publishedTemplate) }
}

/**
 * Validates (throws ZodError) and saves the draft. Order is normalized to array order. `template` is
 * optional: omitted leaves the stored draft template untouched (a widgets-only autosave must not reset it);
 * given, it is validated against PORTAL_TEMPLATES (an unknown id throws ZodError) and saved with the draft.
 */
export async function saveDraft(prisma: AppPrismaClient, workspaceId: string, input: unknown, template?: unknown): Promise<PortalHomeWidget[]> {
  const widgets = normalizeOrder(layoutSchema.parse(input))
  const parsedTemplate = template === undefined ? undefined : portalTemplateSchema.parse(template)
  const now = new Date()
  const templateData = parsedTemplate === undefined ? {} : { draftTemplate: parsedTemplate }
  try {
    await prisma.portalHomeLayout.upsert({
      where: { workspaceId },
      create: { workspaceId, draftWidgets: toJson(widgets), ...templateData, createdAt: now, updatedAt: now },
      update: { draftWidgets: toJson(widgets), ...templateData, updatedAt: now },
      // Never RETURN the whole row: a database that has not applied migration 114 has no template columns.
      select: { id: true },
    })
  } catch (error) {
    // Prisma upsert is not atomic: two first saves racing (an autosave and a flush
    // before publish) can both miss the row, and the unique workspace index rejects
    // the loser. The row exists now, so the loser is simply an update.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error
    await prisma.portalHomeLayout.update({ where: { workspaceId }, data: { draftWidgets: toJson(widgets), ...templateData, updatedAt: new Date() }, select: { id: true } })
  }
  return widgets
}

export class NothingToPublishError extends Error {
  constructor() {
    super("There is no draft to publish")
    this.name = "NothingToPublishError"
  }
}

/** Copies the stored draft to published. Re-validates strictly: a bad draft cannot reach customers. */
export async function publishDraft(
  prisma: AppPrismaClient,
  workspaceId: string,
  userId: string | null,
): Promise<{ published: PortalHomeWidget[]; publishedAt: Date; template: PortalTemplate }> {
  // `templatesMigrated` is false only on a database that has not applied migration 114: publish the widgets, as before.
  let templatesMigrated = true
  let row: { draftWidgets: unknown; draftTemplate?: string | null } | null
  try {
    row = await prisma.portalHomeLayout.findUnique({ where: { workspaceId }, select: { draftWidgets: true, draftTemplate: true } })
  } catch (error) {
    if (!isMissingColumnError(error)) throw error
    templatesMigrated = false
    row = await prisma.portalHomeLayout.findUnique({ where: { workspaceId }, select: { draftWidgets: true } })
  }
  if (!row) throw new NothingToPublishError()
  const widgets = normalizeOrder(layoutSchema.parse(row.draftWidgets))
  // The draft template is copied verbatim; NULL/unknown (a row from before migration 114) publishes as editorial.
  const template = coerceStoredTemplate(row.draftTemplate)
  const publishedAt = new Date()
  await prisma.portalHomeLayout.update({
    where: { workspaceId },
    data: {
      publishedWidgets: toJson(widgets),
      ...(templatesMigrated ? { publishedTemplate: template } : {}),
      publishedAt,
      publishedById: userId,
      updatedAt: publishedAt,
    },
    select: { id: true },
  })
  return { published: widgets, publishedAt, template }
}
