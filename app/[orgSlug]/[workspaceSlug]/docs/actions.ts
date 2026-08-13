"use server";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";
import { createPositioningBriefCore } from "@/lib/positioning-brief";
import { maybeSnapshotDocVersion, restoreDocVersionCore } from "@/lib/doc-versions";

export async function createDoc(
  workspaceId: string,
  parentId: string | null,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();
  const doc = await prisma.doc.create({
    data: { workspaceId, parentId, title: "Untitled" },
  });
  revalidatePath(revalidatePathStr);
  return doc;
}

export async function updateDoc(
  docId: string,
  data: { title?: string; content?: string; icon?: string },
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();

  // Snapshot the doc's pre-change state before applying the new values —
  // but only when this call actually changes something (title/content/icon
  // present), so a no-op call never creates a version.
  if (data.title !== undefined || data.content !== undefined || data.icon !== undefined) {
    await maybeSnapshotDocVersion(docId, {
      authorId: session.user.id,
      authorName: session.user.name ?? session.user.email ?? "Unknown",
    });
  }

  await prisma.doc.update({
    where: { id: docId },
    data: { ...data, updatedAt: new Date() },
  });
  revalidatePath(revalidatePathStr);
}

/**
 * Save a manual, named snapshot of a doc's current content — bypasses the
 * coalescing window in maybeSnapshotDocVersion since a label is always set.
 */
export async function createDocVersion(
  docId: string,
  label: string | undefined,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  await maybeSnapshotDocVersion(docId, {
    authorId: session.user.id,
    authorName: session.user.name ?? session.user.email ?? "Unknown",
    label: label?.trim() || "Snapshot",
  });
  revalidatePath(revalidatePathStr);
}

export async function updateDocMetadata(
  docId: string,
  metadata: Record<string, unknown>,
  revalidatePathStr: string
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();
  await prisma.doc.update({
    where: { id: docId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { metadata: metadata as any, updatedAt: new Date() },
  });
  revalidatePath(revalidatePathStr);
}

/**
 * Create (or return the existing) Positioning & Messaging Brief for a roadmap
 * item, from the roadmap-item panel's Launch section. Returns the brief's doc
 * id so the caller can navigate straight to the editor.
 */
export async function createPositioningBrief(
  roadmapItemId: string,
  workspaceId: string,
  revalidatePathStr: string
): Promise<{ docId: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const result = await createPositioningBriefCore(roadmapItemId, workspaceId);
  if (!result.ok) throw new Error("Roadmap item not found");

  revalidatePath(revalidatePathStr);
  return { docId: result.docId };
}

/**
 * Fetch a single saved version's full content, on demand from the version
 * history panel — kept out of the doc page's initial payload (which only
 * carries id/label/author/createdAt for each version) so opening a doc
 * doesn't pull every historical content blob along with it.
 */
export async function getDocVersionContent(versionId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();
  const version = await prisma.docVersion.findUnique({
    where: { id: versionId },
    select: { id: true, title: true, content: true, createdAt: true, label: true, createdByName: true },
  });
  if (!version) throw new Error("Version not found");
  return version;
}

/**
 * Restore a doc's live content to a previously saved version. The doc's
 * current state is snapshotted first (label "Before restore") so nothing is
 * ever lost by restoring.
 */
export async function restoreDocVersion(versionId: string, revalidatePathStr: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const restored = await restoreDocVersionCore(versionId, {
    authorId: session.user.id,
    authorName: session.user.name ?? session.user.email ?? "Unknown",
  });
  if (!restored) throw new Error("Version not found");

  revalidatePath(revalidatePathStr);
  return restored;
}

export async function deleteDoc(docId: string, revalidatePathStr: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();
  // DSQL has no FK cascade (relationMode = "prisma" emulates referential
  // integrity client-side under NoAction) — delete DocVersion rows first or
  // the doc.delete below throws on orphaned children.
  await prisma.docVersion.deleteMany({ where: { docId } });
  await prisma.doc.delete({ where: { id: docId } });
  revalidatePath(revalidatePathStr);
}
