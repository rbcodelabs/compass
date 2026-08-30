import { NextResponse } from "next/server"
import { getResearchArtifactStorage } from "@/lib/artifact-storage"
import { resolveActiveResearchStudy } from "@/lib/research-access"
import { getParticipantResearchAttachment, ResearchAttachmentError } from "@/lib/research-attachment-service"
import { readBoundedResearchJson, ResearchRequestBodyError } from "@/lib/research-request"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  let body: Record<string, unknown>
  try {
    body = await readBoundedResearchJson(request)
  } catch (error) {
    const status = error instanceof ResearchRequestBodyError ? error.status : 400
    return NextResponse.json({ error: "Invalid request" }, { status })
  }
  if (
    Object.keys(body).some((key) => !["token", "sessionId", "resumeToken"].includes(key)) ||
    typeof body.token !== "string" || typeof body.sessionId !== "string" || typeof body.resumeToken !== "string"
  ) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  const resolved = await resolveActiveResearchStudy(body.token)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  try {
    const { attachmentId } = await params
    const attachment = await getParticipantResearchAttachment({
      context: resolved,
      sessionId: body.sessionId,
      resumeToken: body.resumeToken,
      attachmentId,
    })
    const bytes = await getResearchArtifactStorage().get(attachment.blobPathname)
    if (!bytes) return NextResponse.json({ error: "Attachment not found" }, { status: 404 })
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
  } catch (error) {
    if (error instanceof ResearchAttachmentError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("Research attachment download failed", error)
    return NextResponse.json({ error: "Attachment unavailable" }, { status: 502 })
  }
}
