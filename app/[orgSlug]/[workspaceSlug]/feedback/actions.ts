"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session;
}

export async function updateFeedbackStatus(
  feedbackId: string,
  status: string,
  revalidatePathStr: string
) {
  await requireAuth();
  const prisma = getPrisma();

  await prisma.feedbackItem.update({
    where: { id: feedbackId },
    data: { status },
  });

  revalidatePath(revalidatePathStr);
}

export async function linkFeedbackToOpportunity(
  feedbackId: string,
  opportunityId: string | null,
  revalidatePathStr: string
) {
  await requireAuth();
  const prisma = getPrisma();

  await prisma.feedbackItem.update({
    where: { id: feedbackId },
    data: { opportunityId },
  });

  revalidatePath(revalidatePathStr);
}

export async function updateFeedbackType(
  feedbackId: string,
  type: string,
  revalidatePathStr: string
) {
  await requireAuth();
  const prisma = getPrisma();

  await prisma.feedbackItem.update({
    where: { id: feedbackId },
    data: { type },
  });

  revalidatePath(revalidatePathStr);
}
