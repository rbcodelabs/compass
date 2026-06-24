import { NextRequest, NextResponse } from "next/server";
import getPrisma from "@/lib/db";

type Params = { orgSlug: string; workspaceSlug: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<Params> }
) {
  const { orgSlug, workspaceSlug } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { type, itemId, voterEmail, voterName } = body as Record<string, unknown>;

  if (type !== "feedback" && type !== "roadmap") {
    return NextResponse.json({ error: "type must be 'feedback' or 'roadmap'" }, { status: 422 });
  }

  if (!itemId || typeof itemId !== "string") {
    return NextResponse.json({ error: "itemId is required" }, { status: 422 });
  }

  if (!voterEmail || typeof voterEmail !== "string" || !EMAIL_RE.test(voterEmail.trim())) {
    return NextResponse.json({ error: "A valid email address is required to vote" }, { status: 422 });
  }

  const email = voterEmail.trim().toLowerCase();
  const name =
    typeof voterName === "string" && voterName.trim() ? voterName.trim() : null;

  const prisma = getPrisma();

  // Verify workspace exists
  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, feedbackEnabled: true, roadmapPublic: true },
  });

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  if (type === "feedback") {
    if (!workspace.feedbackEnabled) {
      return NextResponse.json({ error: "Feedback is not enabled" }, { status: 403 });
    }

    const feedbackItem = await prisma.feedbackItem.findFirst({
      where: { id: itemId, workspaceId: workspace.id },
      select: { id: true, voteCount: true },
    });

    if (!feedbackItem) {
      return NextResponse.json({ error: "Feedback item not found" }, { status: 404 });
    }

    // Check if already voted
    const existing = await prisma.feedbackVote.findFirst({
      where: { feedbackId: itemId, voterEmail: email },
    });

    let newVoteCount = feedbackItem.voteCount;

    if (!existing) {
      await prisma.feedbackVote.create({
        data: { feedbackId: itemId, voterEmail: email },
      });

      const updated = await prisma.feedbackItem.update({
        where: { id: itemId },
        data: { voteCount: { increment: 1 } },
        select: { voteCount: true },
      });
      newVoteCount = updated.voteCount;
    }

    return NextResponse.json({ success: true, voteCount: newVoteCount });
  }

  // type === "roadmap"
  if (!workspace.roadmapPublic) {
    return NextResponse.json({ error: "Roadmap is not public" }, { status: 403 });
  }

  const roadmapItem = await prisma.roadmapItem.findFirst({
    where: { id: itemId, workspaceId: workspace.id },
    select: { id: true },
  });

  if (!roadmapItem) {
    return NextResponse.json({ error: "Roadmap item not found" }, { status: 404 });
  }

  // Check if already voted
  const existingVote = await prisma.roadmapVote.findFirst({
    where: { roadmapItemId: itemId, voterEmail: email },
  });

  if (!existingVote) {
    await prisma.roadmapVote.create({
      data: {
        roadmapItemId: itemId,
        voterEmail: email,
        voterName: name,
      },
    });
  }

  const voteCount = await prisma.roadmapVote.count({
    where: { roadmapItemId: itemId },
  });

  return NextResponse.json({ success: true, voteCount });
}
