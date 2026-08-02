"use server";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";
import { createPositioningBriefCore } from "@/lib/positioning-brief";

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
  await prisma.doc.update({
    where: { id: docId },
    data: { ...data, updatedAt: new Date() },
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

export async function deleteDoc(docId: string, revalidatePathStr: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();
  await prisma.doc.delete({ where: { id: docId } });
  revalidatePath(revalidatePathStr);
}
