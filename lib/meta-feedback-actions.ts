"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { validateFeedbackInput } from "@/lib/feedback";
import type { FeedbackType } from "@/lib/types";

/**
 * Where "Send Feedback about Compass" always lands, regardless of which
 * org/workspace the user is currently in. Configurable so this can point
 * at a different target in non-standard deployments; defaults match the
 * production dogfooding workspace.
 */
const TARGET_ORG_SLUG = process.env.FEEDBACK_TARGET_ORG_SLUG ?? "rbcodelabs";
const TARGET_WORKSPACE_SLUG = process.env.FEEDBACK_TARGET_WORKSPACE_SLUG ?? "compass";

export type SendCompassFeedbackResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Global, always-available "feedback about Compass itself" entry point
 * (sidebar + mobile header), reachable from any org/workspace the user is
 * in. Always routes into the configured target workspace rather than the
 * user's current one — this replaces the prior workaround of an external
 * agent skill hardcoding a curl to rbcodelabs/compass with a real in-app
 * flow. Identity is resolved server-side via the authenticated session,
 * never trusted from client input.
 */
export async function sendCompassFeedback(data: {
  title: string;
  description: string;
  type: FeedbackType;
}): Promise<SendCompassFeedbackResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "Unauthorized" };
  }

  const validation = validateFeedbackInput(data);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }

  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: TARGET_WORKSPACE_SLUG,
      organization: { slug: TARGET_ORG_SLUG },
    },
    select: { id: true },
  });

  // Handled gracefully rather than thrown: a misconfigured env var (or a
  // deployment that hasn't created the target workspace yet) shouldn't
  // surface as an unhandled 500 to a user just trying to report a bug.
  if (!workspace) {
    return {
      ok: false,
      error: `Feedback target workspace (${TARGET_ORG_SLUG}/${TARGET_WORKSPACE_SLUG}) was not found`,
    };
  }

  const item = await prisma.feedbackItem.create({
    data: {
      workspaceId: workspace.id,
      title: validation.data.title,
      description: validation.data.description,
      type: data.type,
      submitterName: session.user.name ?? null,
      submitterEmail: session.user.email ?? null,
    },
    select: { id: true },
  });

  revalidatePath(`/${TARGET_ORG_SLUG}/${TARGET_WORKSPACE_SLUG}/feedback`);

  return { ok: true, id: item.id };
}
