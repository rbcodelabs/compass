"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { validateFeedbackInput } from "@/lib/feedback";
import type { FeedbackType } from "@/lib/types";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session;
}

export type CreatedFeedbackItem = {
  id: string;
  title: string;
  description: string | null;
  submitterName: string | null;
  submitterEmail: string | null;
  status: string;
  voteCount: number;
  type: FeedbackType;
  opportunityId: string | null;
  createdAt: string;
};

export type CreateFeedbackResult =
  | { ok: true; item: CreatedFeedbackItem }
  | { ok: false; error: string };

/**
 * Creates a feedback item directly from inside the workspace's own
 * Feedback board (the "New Feedback" dialog) — the in-app counterpart to
 * the public portal route, scoped to whatever workspace the current user
 * is in. Identity is resolved server-side via the authenticated session,
 * never trusted from client input.
 */
export async function createFeedback(
  orgSlug: string,
  workspaceSlug: string,
  data: { title: string; description: string; type: FeedbackType },
  revalidatePathStr: string
): Promise<CreateFeedbackResult> {
  const session = await requireAuth();

  const validation = validateFeedbackInput(data);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }

  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  });
  if (!workspace) {
    return { ok: false, error: "Workspace not found" };
  }

  const item = await prisma.feedbackItem.create({
    data: {
      workspaceId: workspace.id,
      title: validation.data.title,
      description: validation.data.description,
      type: data.type,
      // Non-null assertion: requireAuth() already threw if session.user.id
      // was missing, but that narrowing doesn't survive the function
      // boundary in TS's control-flow analysis.
      submitterName: session.user!.name ?? null,
      submitterEmail: session.user!.email ?? null,
    },
    select: {
      id: true,
      title: true,
      description: true,
      submitterName: true,
      submitterEmail: true,
      status: true,
      voteCount: true,
      type: true,
      opportunityId: true,
      createdAt: true,
    },
  });

  revalidatePath(revalidatePathStr);

  return {
    ok: true,
    item: {
      id: item.id,
      title: item.title,
      description: item.description,
      submitterName: item.submitterName,
      submitterEmail: item.submitterEmail,
      status: item.status,
      voteCount: item.voteCount,
      type: item.type as FeedbackType,
      opportunityId: item.opportunityId,
      createdAt: item.createdAt.toISOString(),
    },
  };
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
