"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { feedbackOpportunityLinkData, validateFeedbackInput } from "@/lib/feedback";
import {
  deleteFeedbackBlobs,
  prepareFeedbackAttachmentUpload,
  verifyCompletedFeedbackUpload,
  verifyFeedbackUploadOwnership,
} from "@/lib/feedback-attachments";
import {
  FEEDBACK_ATTACHMENT_MAX_COUNT,
  IN_APP_RECEIPT_GRACE_MS,
  feedbackAttachmentRejection,
} from "@/lib/feedback-attachment-rules";
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
  attachments: Array<{ id: string; url: string; filename: string; fileType: string }>;
};

export type CreateFeedbackResult =
  | { ok: true; item: CreatedFeedbackItem }
  | {
      ok: false;
      error: string;
      /** Set when one specific attachment is the reason the create was refused. */
      attachmentUrl?: string;
    };

/** A finished direct-to-Blob upload, as the composer hands it to the server. */
export type UploadedFeedbackAttachment = { url: string; receipt: string };

/**
 * Resolve the workspace only if the signed-in user is a member of it. A server
 * action is a public POST endpoint: checking the session alone would let any
 * signed-in user write into any workspace whose slugs they can guess.
 */
async function findMemberWorkspace(orgSlug: string, workspaceSlug: string, userId: string) {
  return getPrisma().workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
      members: { some: { userId } },
    },
    select: { id: true },
  });
}

/**
 * Creates a feedback item directly from inside the workspace's own
 * Feedback board (the "New feedback" composer panel) — the in-app counterpart
 * to the public portal route, scoped to whatever workspace the current user
 * is in. Identity is resolved server-side via the authenticated session,
 * never trusted from client input.
 *
 * Attachments are uploaded straight to Blob *before* this is called (see
 * `prepareFeedbackAttachment`), so creation is a single write: the item and
 * every attachment row are created together or not at all. Each upload is
 * verified against its signed receipt and the blob's real metadata first; if
 * any one fails, nothing is created and `attachmentUrl` names the culprit so
 * the composer can flag that chip instead of the whole form.
 */
export async function createFeedback(
  orgSlug: string,
  workspaceSlug: string,
  data: {
    title: string;
    description: string;
    type: FeedbackType;
    attachments?: UploadedFeedbackAttachment[];
  },
  revalidatePathStr: string
): Promise<CreateFeedbackResult> {
  const session = await requireAuth();

  const validation = validateFeedbackInput(data);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }
  if (data.type !== "IDEA" && data.type !== "BUG") {
    return { ok: false, error: "Type must be Idea or Bug" };
  }

  const uploads = data.attachments ?? [];
  if (!Array.isArray(uploads) || uploads.length > FEEDBACK_ATTACHMENT_MAX_COUNT) {
    return { ok: false, error: `Attach at most ${FEEDBACK_ATTACHMENT_MAX_COUNT} files.` };
  }

  const workspace = await findMemberWorkspace(orgSlug, workspaceSlug, session.user!.id!);
  if (!workspace) {
    return { ok: false, error: "Workspace not found" };
  }

  const attachmentRows: Array<{
    id: string;
    url: string;
    filename: string;
    fileType: string;
    fileSize: number;
  }> = [];
  for (const upload of uploads) {
    try {
      const verified = await verifyCompletedFeedbackUpload(
        { workspaceId: workspace.id, url: upload.url, receipt: upload.receipt },
        { graceMs: IN_APP_RECEIPT_GRACE_MS },
      );
      if (attachmentRows.some((row) => row.id === verified.attachmentId)) continue;
      attachmentRows.push({
        id: verified.attachmentId,
        url: verified.url,
        filename: verified.filename,
        fileType: verified.fileType,
        fileSize: verified.fileSize,
      });
    } catch {
      return {
        ok: false,
        error: "One attachment could not be verified. Remove it (or attach it again) and resubmit.",
        attachmentUrl: typeof upload?.url === "string" ? upload.url : undefined,
      };
    }
  }

  const prisma = getPrisma();
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
      ...(attachmentRows.length ? { attachments: { create: attachmentRows } } : {}),
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
      attachments: { select: { id: true, url: true, filename: true, fileType: true } },
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
      attachments: item.attachments ?? [],
    },
  };
}

export type PrepareFeedbackAttachmentResult =
  | {
      ok: true;
      upload: { clientToken: string; receipt: string; pathname: string; expiresAt: number };
    }
  | { ok: false; error: string };

/**
 * Step one of an in-app attachment: validate the file's metadata and mint a
 * single-use, size- and type-locked client token for a direct browser→Blob
 * upload, plus a signed receipt that `createFeedback` later verifies.
 *
 * Same storage, limits and receipt format as the MCP
 * `prepare_feedback_attachment_upload` tool — only the caller's identity check
 * differs (workspace membership instead of an MCP actor). Going direct to Blob
 * rather than through a route handler keeps the 10 MB limit real: a
 * function-routed upload would hit the platform's ~4.5 MB request body cap.
 */
export async function prepareFeedbackAttachment(
  orgSlug: string,
  workspaceSlug: string,
  file: { filename: string; fileType: string; fileSize: number }
): Promise<PrepareFeedbackAttachmentResult> {
  try {
    const session = await requireAuth();
    const rejection = feedbackAttachmentRejection({
      name: file?.filename,
      size: file?.fileSize,
      type: file?.fileType,
    });
    if (rejection) return { ok: false, error: rejection };
    if (!Number.isInteger(file.fileSize)) return { ok: false, error: "Invalid file size." };

    const workspace = await findMemberWorkspace(orgSlug, workspaceSlug, session.user!.id!);
    if (!workspace) return { ok: false, error: "Workspace not found" };

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return { ok: false, error: "Attachments aren’t available in this environment." };
    }
    const prepared = await prepareFeedbackAttachmentUpload({
      workspaceId: workspace.id,
      filename: file.filename,
      fileType: file.fileType,
      fileSize: file.fileSize,
    });
    return {
      ok: true,
      upload: {
        clientToken: prepared.clientToken,
        receipt: prepared.receipt,
        pathname: prepared.pathname,
        expiresAt: prepared.expiresAt,
      },
    };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Best-effort cleanup when the user removes an uploaded attachment from the
 * composer before submitting. Only deletes a blob the server minted for this
 * workspace (receipt + exact URL match) and never one already linked to a
 * feedback item. Failure is harmless to the user, so callers ignore it.
 */
export async function discardFeedbackAttachment(
  orgSlug: string,
  workspaceSlug: string,
  upload: UploadedFeedbackAttachment
): Promise<FeedbackMutationResult> {
  try {
    const session = await requireAuth();
    const workspace = await findMemberWorkspace(orgSlug, workspaceSlug, session.user!.id!);
    if (!workspace) return { ok: false, error: "Workspace not found" };

    verifyFeedbackUploadOwnership(
      { workspaceId: workspace.id, url: upload.url, receipt: upload.receipt },
      { graceMs: IN_APP_RECEIPT_GRACE_MS },
    );
    const linked = await getPrisma().feedbackAttachment.findFirst({
      where: { url: upload.url },
      select: { id: true },
    });
    if (linked) return { ok: false, error: "That file is already attached to feedback." };

    await deleteFeedbackBlobs([upload.url]);
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
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
      data: feedbackOpportunityLinkData(opportunityId),
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
