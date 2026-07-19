import { put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import getPrisma from "@/lib/db";
import { getPortalSession } from "@/lib/portal-auth";

type Params = { orgSlug: string; workspaceSlug: string };

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Strips everything except alphanumerics, dots, underscores, and hyphens. */
function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<Params> }
) {
  const { orgSlug, workspaceSlug } = await params;

  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, feedbackEnabled: true, portalAuthRequired: true },
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

  if (workspace.portalAuthRequired) {
    const session = await getPortalSession();
    if (!session) {
      return NextResponse.json(
        { error: "Sign in required to submit feedback", code: "PORTAL_AUTH_REQUIRED" },
        { status: 401 }
      );
    }
  }

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json({ error: "Max 10MB" }, { status: 400 });
  }

  const safeName = sanitizeFilename(file.name);

  const blob = await put(`feedback/${workspace.id}/${Date.now()}-${safeName}`, file, {
    access: "public",
  });

  return NextResponse.json({
    url: blob.url,
    filename: file.name,
    fileType: file.type,
    fileSize: file.size,
  });
}
