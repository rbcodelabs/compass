"use server";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import getPrisma from "@/lib/db";

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

export async function deleteDoc(docId: string, revalidatePathStr: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const prisma = getPrisma();
  await prisma.doc.delete({ where: { id: docId } });
  revalidatePath(revalidatePathStr);
}
