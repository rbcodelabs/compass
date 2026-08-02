/**
 * Core for creating a Positioning & Messaging Brief for a roadmap item. A
 * brief is a Doc with docType "GTM_POSITIONING_BRIEF" linked 1:1 to a
 * RoadmapItem (Doc.roadmapItemId is unique), pre-filled from
 * GTM_POSITIONING_BRIEF_TEMPLATE. Used by the web server action; the MCP
 * create_doc tool creates briefs through its own general doc-creation path
 * (byte-identical text output preserved by leaving that handler untouched).
 */
import getPrisma from "@/lib/db";
import { GTM_POSITIONING_BRIEF_TEMPLATE } from "@/lib/gtm-templates";

export type CreatePositioningBriefResult =
  | { ok: true; docId: string; title: string; created: boolean }
  | { ok: false; error: "item_not_found" };

/**
 * Ensure a positioning brief exists for `roadmapItemId` (scoped to
 * `workspaceId`). Idempotent: if one already exists it's returned with
 * `created: false`; otherwise a fresh templated brief is created. Returns the
 * doc id so the caller can navigate straight to the editor.
 */
export async function createPositioningBriefCore(
  roadmapItemId: string,
  workspaceId: string
): Promise<CreatePositioningBriefResult> {
  const prisma = getPrisma();

  const item = await prisma.roadmapItem.findFirst({
    where: { id: roadmapItemId, workspaceId },
    select: { id: true, title: true },
  });
  if (!item) return { ok: false, error: "item_not_found" };

  // A roadmap item has at most one brief (Doc.roadmapItemId is unique).
  const existing = await prisma.doc.findUnique({
    where: { roadmapItemId },
    select: { id: true, title: true },
  });
  if (existing) {
    return { ok: true, docId: existing.id, title: existing.title, created: false };
  }

  // Root-level doc, placed after the current last sibling. The GTM template
  // has no YAML frontmatter, so its whole text is the body (matching how
  // create_doc stores a template-seeded brief).
  const lastSibling = await prisma.doc.findFirst({
    where: { workspaceId, parentId: null },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  const doc = await prisma.doc.create({
    data: {
      workspaceId,
      parentId: null,
      title: `Positioning Brief — ${item.title}`,
      content: GTM_POSITIONING_BRIEF_TEMPLATE,
      sortOrder: lastSibling ? lastSibling.sortOrder + 1 : 0,
      roadmapItemId,
      docType: "GTM_POSITIONING_BRIEF",
    },
  });

  return { ok: true, docId: doc.id, title: doc.title, created: true };
}
