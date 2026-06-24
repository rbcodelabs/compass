import { NextRequest, NextResponse } from "next/server";
import getPrisma from "@/lib/db";

type Params = { orgSlug: string; workspaceSlug: string };

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

  const { title, description, submitterName, submitterEmail } = body as Record<string, unknown>;

  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json({ error: "Title is required" }, { status: 422 });
  }

  if (title.trim().length > 255) {
    return NextResponse.json({ error: "Title must be 255 characters or fewer" }, { status: 422 });
  }

  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, feedbackEnabled: true },
  });

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  if (!workspace.feedbackEnabled) {
    return NextResponse.json({ error: "Feedback is not enabled for this workspace" }, { status: 403 });
  }

  const item = await prisma.feedbackItem.create({
    data: {
      workspaceId: workspace.id,
      title: title.trim(),
      description: typeof description === "string" && description.trim() ? description.trim() : null,
      submitterName: typeof submitterName === "string" && submitterName.trim() ? submitterName.trim() : null,
      submitterEmail: typeof submitterEmail === "string" && submitterEmail.trim() ? submitterEmail.trim() : null,
    },
    select: { id: true, title: true, status: true, voteCount: true, createdAt: true },
  });

  return NextResponse.json({
    id: item.id,
    title: item.title,
    status: item.status,
    voteCount: item.voteCount,
    createdAt: item.createdAt.toISOString(),
  });
}
