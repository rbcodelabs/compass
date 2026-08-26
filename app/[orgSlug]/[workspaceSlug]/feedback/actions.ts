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

/**
 * The result shape every feedback mutation returns.
 *
 * These used to be `Promise<void>` functions that threw. A server action that
 * throws surfaces in the client as an unhandled promise rejection in
 * production (Next strips the message), so the DataGrid's optimistic overlay
 * could never see the failure and could never roll back. Returning a
 * discriminated result — matching the `CreateFeedbackResult` precedent above —
 * makes failure a value the caller must handle.
 *
 * `updatedAt: new Date()` is set explicitly on every write: the schema uses
 * `@default(now())` rather than `@updatedAt` because Aurora DSQL has no
 * trigger support, so nothing updates the column for us.
 */
export type FeedbackMutationResult = { ok: true } | { ok: false; error: string };

/**
 * `revalidatePathStr` accepts `null` to mean **do not revalidate anything**.
 *
 * This is not a micro-optimisation, it is load-bearing, and it was proven
 * against a real browser rather than reasoned about:
 *
 *   A Server Action that revalidates *anything* causes Next to include a fresh
 *   RSC payload **for the route the action was called from** in the action's
 *   response. Measured in `feedback-grid.spec.ts`'s stale-row journey: after an
 *   inline status edit under `?status=OPEN`, the "no longer matches your
 *   filters" strip rendered and then vanished ~300ms later, with the row count
 *   dropping 5 → 4. Re-running the same experiment with a completely unrelated
 *   revalidate path produced byte-identical results, which rules out "it only
 *   happens when you revalidate the current path".
 *
 *   So the DataGrid's stay-and-mark behaviour — an inline edit that pushes a
 *   row out of the active filter leaves it in place, marked stale, until the
 *   user clicks Refresh — is *incompatible* with revalidating from the edit.
 *   Silently yanking the row would leave a 24-of-25 page and desync the total
 *   and every later page's offset, which is the exact bug stay-and-mark exists
 *   to prevent.
 *
 * The cost of skipping it is close to zero: `/portal/.../feedback` and
 * `/{org}/{ws}/roadmap` are both **dynamic** routes (`ƒ` in `next build`), so
 * they hold no full route cache, and the portal is browsed in a different,
 * unauthenticated session whose router cache this process cannot touch anyway.
 *
 * Callers that are *not* holding an optimistic overlay (the detail panel, the
 * create dialog) keep passing a path and keep the old behaviour.
 */
type RevalidateTarget = string | null;

/** Turn a thrown error into a result object. Never rethrows. */
function toFailure(error: unknown): { ok: false; error: string } {
  if (error instanceof Error && error.message === "Unauthorized") {
    return { ok: false, error: "You are not signed in." };
  }
  return {
    ok: false,
    error: error instanceof Error ? error.message : "Something went wrong.",
  };
}

export async function updateFeedbackStatus(
  feedbackId: string,
  status: string,
  revalidatePathStr: RevalidateTarget
): Promise<FeedbackMutationResult> {
  try {
    await requireAuth();
    const prisma = getPrisma();

    await prisma.feedbackItem.update({
      where: { id: feedbackId },
      data: { status, updatedAt: new Date() },
    });

    // `null` = the caller owns an optimistic overlay; see RevalidateTarget.
    if (revalidatePathStr) revalidatePath(revalidatePathStr);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

export async function linkFeedbackToOpportunity(
  feedbackId: string,
  opportunityId: string | null,
  revalidatePathStr: RevalidateTarget
): Promise<FeedbackMutationResult> {
  try {
    await requireAuth();
    const prisma = getPrisma();

    await prisma.feedbackItem.update({
      where: { id: feedbackId },
      data: { opportunityId, updatedAt: new Date() },
    });

    // `null` = the caller owns an optimistic overlay; see RevalidateTarget.
    if (revalidatePathStr) revalidatePath(revalidatePathStr);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

export async function updateFeedbackType(
  feedbackId: string,
  type: string,
  revalidatePathStr: RevalidateTarget
): Promise<FeedbackMutationResult> {
  try {
    await requireAuth();
    const prisma = getPrisma();

    await prisma.feedbackItem.update({
      where: { id: feedbackId },
      data: { type, updatedAt: new Date() },
    });

    // `null` = the caller owns an optimistic overlay; see RevalidateTarget.
    if (revalidatePathStr) revalidatePath(revalidatePathStr);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}
