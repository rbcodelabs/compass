import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { getArtifactStorage } from "@/lib/artifact-storage";
import { createDocImage } from "@/lib/doc-images";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const workspaceId = String(form.get("workspaceId") ?? "");
  const file = form.get("file") as File | null;
  const workspace = workspaceId ? await getPrisma().workspace.findFirst({ where: { id: workspaceId, members: { some: { userId: session.user.id } } }, select: { id: true } }) : null;
  if (!workspace) return NextResponse.json({ error: "Workspace not found or access denied" }, { status: 404 });
  if (!file) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }

  try {
    const image = await createDocImage({ workspaceId, filename: file.name, fileType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }, getArtifactStorage());
    return NextResponse.json({ url: image.url });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Image upload failed" }, { status: 400 });
  }
}
