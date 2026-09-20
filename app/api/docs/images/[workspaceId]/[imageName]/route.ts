import { auth } from "@/auth"
import { getArtifactStorage } from "@/lib/artifact-storage"
import getPrisma from "@/lib/db"
import { resolveDocImage } from "@/lib/doc-images"
import { NextRequest, NextResponse } from "next/server"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ workspaceId: string; imageName: string }> }) {
  const session = await auth()
  const { workspaceId, imageName } = await params
  if (!session?.user?.id) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const resolved = resolveDocImage(workspaceId, imageName)
  if (!resolved) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const workspace = await getPrisma().workspace.findFirst({ where: { id: workspaceId, members: { some: { userId: session.user.id } } }, select: { id: true } })
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 })
  try {
    const bytes = await getArtifactStorage().get(resolved.pathname)
    if (!bytes) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { headers: { "Content-Type": resolved.fileType, "Content-Disposition": `inline; filename="${imageName}"`, "Content-Length": String(bytes.byteLength), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } })
  } catch (error) {
    console.error("Docs image read failed", error)
    return NextResponse.json({ error: "Image unavailable" }, { status: 502 })
  }
}
