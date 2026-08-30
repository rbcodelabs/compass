import { auth } from "@/auth"
import { getArtifactStorage } from "@/lib/artifact-storage"
import getPrisma from "@/lib/db"

export const runtime = "nodejs"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) return Response.json({ error: "Not found" }, { status: 404 })
  const { attachmentId } = await params
  const attachment = await getPrisma().researchAttachment.findFirst({
    where: {
      id: attachmentId,
      status: "READY",
      workspace: { members: { some: { userId: session.user.id } } },
    },
  })
  if (!attachment) return Response.json({ error: "Not found" }, { status: 404 })
  const bytes = await getArtifactStorage().get(attachment.blobPathname)
  if (!bytes) return Response.json({ error: "Not found" }, { status: 404 })
  const safeName = attachment.originalName.replace(/["\r\n]/g, "_")
  return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
