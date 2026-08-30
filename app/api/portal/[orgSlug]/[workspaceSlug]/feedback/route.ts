import { NextRequest, NextResponse } from "next/server";
import getPrisma from "@/lib/db";
import { getPortalSession } from "@/lib/portal-auth";
import {
  type FeedbackAttachmentMetadata,
  validateFeedbackAttachmentMetadata,
} from "@/lib/feedback-attachments";

type Params = { orgSlug: string; workspaceSlug: string };

/**
 * A submitted attachment is only trusted if its URL is an https:// URL on
 * Vercel Blob's public storage domain — this stops arbitrary URLs (e.g.
 * pointing at internal services or unrelated hosts) from being injected
 * into feedback records via the JSON body.
 */
const isValidBlobAttachment = validateFeedbackAttachmentMetadata;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<Params> }
) {
  const { orgSlug, workspaceSlug } = await params;

  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam !== null ? parseInt(limitParam, 10) : 50;

  if (isNaN(limit) || limit < 1 || limit > 500) {
    return NextResponse.json(
      { error: "limit must be a number between 1 and 500" },
      { status: 400 }
    );
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
    return NextResponse.json(
      { error: "Feedback is not enabled for this workspace" },
      { status: 403 }
    );
  }

  const items = await prisma.feedbackItem.findMany({
    where: { workspaceId: workspace.id },
    select: {
      id: true,
      title: true,
      description: true,
      submitterName: true,
      status: true,
      voteCount: true,
      createdAt: true,
      attachments: {
        select: { id: true, url: true, filename: true, fileType: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return NextResponse.json({
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      submitterName: item.submitterName,
      status: item.status,
      voteCount: item.voteCount,
      createdAt: item.createdAt.toISOString(),
      attachments: item.attachments,
    })),
  });
}

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

  const { title, description, submitterName, submitterEmail, type, attachments } = body as Record<string, unknown>;

  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json({ error: "Title is required" }, { status: 422 });
  }

  if (title.trim().length > 255) {
    return NextResponse.json({ error: "Title must be 255 characters or fewer" }, { status: 422 });
  }

  if (type !== undefined && type !== "BUG" && type !== "IDEA") {
    return NextResponse.json({ error: "Type must be 'BUG' or 'IDEA'" }, { status: 422 });
  }

  const feedbackType = type === "BUG" ? "BUG" : "IDEA";

  const rawAttachments = attachments === undefined ? [] : attachments;
  if (!Array.isArray(rawAttachments)) {
    return NextResponse.json({ error: "Invalid attachment URL" }, { status: 422 });
  }
  if (rawAttachments.length > 5) {
    return NextResponse.json({ error: "Maximum 5 attachments" }, { status: 422 });
  }
  if (!rawAttachments.every(isValidBlobAttachment)) {
    return NextResponse.json({ error: "Invalid attachment URL" }, { status: 422 });
  }
  const validatedAttachments = rawAttachments as FeedbackAttachmentMetadata[];

  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, feedbackEnabled: true, portalAuthRequired: true },
  });

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  if (!workspace.feedbackEnabled) {
    return NextResponse.json({ error: "Feedback is not enabled for this workspace" }, { status: 403 });
  }

  // Resolve identity: if this workspace requires a verified portal account,
  // a valid session is mandatory and its email is authoritative — any
  // client-supplied submitterEmail is ignored so a signed-in visitor can't
  // spoof a different address than the one they verified.
  let portalAccountId: string | null = null;
  let effectiveSubmitterEmail: string | null =
    typeof submitterEmail === "string" && submitterEmail.trim() ? submitterEmail.trim() : null;

  if (workspace.portalAuthRequired) {
    const session = await getPortalSession();
    if (!session) {
      return NextResponse.json(
        { error: "Sign in required to submit feedback", code: "PORTAL_AUTH_REQUIRED" },
        { status: 401 }
      );
    }
    portalAccountId = session.portalAccountId;
    effectiveSubmitterEmail = session.email;
  }

  const item = await prisma.feedbackItem.create({
    data: {
      workspaceId: workspace.id,
      title: title.trim(),
      description: typeof description === "string" && description.trim() ? description.trim() : null,
      type: feedbackType,
      submitterName: typeof submitterName === "string" && submitterName.trim() ? submitterName.trim() : null,
      submitterEmail: effectiveSubmitterEmail,
      portalAccountId,
      attachments: { create: validatedAttachments },
    },
    select: {
      id: true,
      title: true,
      status: true,
      voteCount: true,
      type: true,
      createdAt: true,
      attachments: {
        select: { id: true, url: true, filename: true, fileType: true },
      },
    },
  });

  return NextResponse.json({
    id: item.id,
    title: item.title,
    status: item.status,
    voteCount: item.voteCount,
    type: item.type,
    createdAt: item.createdAt.toISOString(),
    attachments: item.attachments,
  });
}
