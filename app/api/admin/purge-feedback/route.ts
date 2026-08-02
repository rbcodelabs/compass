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
//   - Every delete is scoped to the resolved workspace's id, so passing ids
//     that belong to a different workspace deletes nothing.

import { NextRequest, NextResponse } from "next/server";
import getPrisma from "@/lib/db";

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.MIGRATION_SECRET;
  if (!secret) return false;
  return req.headers.get("x-migration-secret") === secret;
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

  // Delete children first (votes, attachments), then the items themselves.
  // The item delete is scoped to { id in list, workspaceId } — the guard that
  // makes cross-workspace deletion and mass deletion impossible.
  await prisma.feedbackVote.deleteMany({
    where: { feedbackId: { in: feedbackIds } },
  });
  await prisma.feedbackAttachment.deleteMany({
    where: { feedbackItemId: { in: feedbackIds } },
  });
  const { count } = await prisma.feedbackItem.deleteMany({
    where: { id: { in: feedbackIds }, workspaceId: workspace.id },
  });

  return NextResponse.json({ deleted: count, requested: feedbackIds.length });
}
