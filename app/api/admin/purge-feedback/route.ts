// One-time-ops admin endpoint: hard-deletes an explicit, caller-supplied set
// of feedback items from a single workspace.
//
// Why this exists: the public portal feedback form
// (POST /api/portal/[org]/[workspace]/feedback) is unauthenticated, so bots
// periodically submit spam. Closing an item does NOT hide it from the public
// portal feedback board (that query only filters out DECLINED), and the MCP
// API can neither hard-delete feedback nor set DECLINED. This gives us a
// server-to-server way to permanently remove specific spam rows.
//
// POST /api/admin/purge-feedback
// Headers: x-migration-secret: <MIGRATION_SECRET>
// Body: { orgSlug: string, workspaceSlug: string, feedbackIds: string[] }
//
// Same trust boundary as /api/admin/migrate — protected by MIGRATION_SECRET,
// not a session.
//
// Safety invariants:
//   - feedbackIds must be a non-empty array of strings. There is deliberately
//     no "delete all" mode: an empty/missing list is a 400, never a mass
//     delete of the workspace's feedback.
//   - The caller's ids are first resolved against FeedbackItem filtered by the
//     workspace id; every subsequent delete is driven off that resolved list.
//     FeedbackVote and FeedbackAttachment carry no workspaceId column, so a
//     delete keyed directly on caller-supplied ids CANNOT be tenancy-scoped —
//     resolving through FeedbackItem first is what makes passing another
//     workspace's ids delete nothing.
//
// The response reports requested / resolved / deleted separately so a scope
// mismatch is visible rather than looking like a clean no-op.

import { NextRequest, NextResponse } from "next/server";
import getPrisma from "@/lib/db";
import { deleteLinksForEntity } from "@/lib/links/service";
import { drainAfterParentDelete } from "@/lib/typed-links";
import { secretMatches } from "@/lib/secret-compare";
import { releaseOwnedFeedbackBlobs } from "@/lib/feedback-attachment-ownership";

// Releasing the files runs inside this request (its counts are in the response) under a 20 s budget; the platform default limit
// is not guaranteed to cover that, so the limit is explicit.
export const maxDuration = 60;

function checkAuth(req: NextRequest): boolean {
  return secretMatches(req.headers.get("x-migration-secret"), process.env.MIGRATION_SECRET);
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const orgSlug = body?.orgSlug;
  const workspaceSlug = body?.workspaceSlug;
  const feedbackIds = body?.feedbackIds;

  if (typeof orgSlug !== "string" || typeof workspaceSlug !== "string") {
    return NextResponse.json(
      { error: "orgSlug and workspaceSlug are required" },
      { status: 400 }
    );
  }

  if (
    !Array.isArray(feedbackIds) ||
    feedbackIds.length === 0 ||
    !feedbackIds.every((id) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "feedbackIds must be a non-empty array of strings" },
      { status: 400 }
    );
  }

  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  });
  if (!workspace) {
    return NextResponse.json(
      { error: `No workspace found for ${orgSlug}/${workspaceSlug}` },
      { status: 404 }
    );
  }

  // Resolve the caller's ids down to the ones that actually live in this
  // workspace, ONCE, before deleting anything. FeedbackVote and
  // FeedbackAttachment have no workspaceId of their own, so this resolved list
  // is the only thing that can scope a child delete to the workspace.
  const inScope = await prisma.feedbackItem.findMany({
    where: { id: { in: feedbackIds }, workspaceId: workspace.id },
    select: { id: true },
  });
  const scopedIds = inScope.map((f) => f.id);

  if (scopedIds.length === 0) {
    return NextResponse.json({
      deleted: 0,
      requested: feedbackIds.length,
      resolved: 0,
    });
  }

  // The files behind the attachment rows are released after the rows are gone, so remember their URLs first. A failed read only means
  // the files leak (as they always did); it never stops the purge.
  let attachmentUrls: string[] = [];
  try {
    const attachments = await prisma.feedbackAttachment.findMany({
      where: { feedbackItemId: { in: scopedIds } },
      select: { url: true },
    });
    attachmentUrls = attachments.map((a) => a.url);
  } catch (error) {
    console.warn("[purge-feedback] could not read attachment urls; their files will not be released", error);
  }

  // Delete children first (votes, attachments), then the items themselves —
  // every delete driven off scopedIds, never the raw caller input.
  await prisma.feedbackVote.deleteMany({
    where: { feedbackId: { in: scopedIds } },
  });
  await prisma.feedbackAttachment.deleteMany({
    where: { feedbackItemId: { in: scopedIds } },
  });
  const { count } = await prisma.feedbackItem.deleteMany({
    // scopedIds is already workspace-filtered; the workspaceId guard is kept
    // as defense in depth.
    where: { id: { in: scopedIds }, workspaceId: workspace.id },
  });

  // Mirror rows of task links to the deleted items (ADR phase 7); failures are logged and swallowed, migration 097 prunes what is left.
  await drainAfterParentDelete("purge-feedback.links", () => deleteLinksForEntity(prisma, "FEEDBACK_ITEM", scopedIds));

  // Only now that the rows are gone: delete the purging workspace's own files that no other row still references. Never throws.
  const blobs = await releaseOwnedFeedbackBlobs(prisma, workspace.id, attachmentUrls);

  return NextResponse.json({
    deleted: count,
    requested: feedbackIds.length,
    resolved: scopedIds.length,
    blobsDeleted: blobs.deleted,
    blobsKept: blobs.kept,
    blobsDryRun: blobs.dryRun,
  });
}
