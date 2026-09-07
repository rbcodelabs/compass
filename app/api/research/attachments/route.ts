import { NextResponse } from "next/server"
import { getResearchArtifactStorage } from "@/lib/artifact-storage"
import { resolveActiveResearchStudy } from "@/lib/research-access"
import { createParticipantResearchAttachment, ResearchAttachmentError } from "@/lib/research-attachment-service"
import { MAX_RESEARCH_ATTACHMENT_BYTES } from "@/lib/research-attachments"

export const runtime = "nodejs"

const FIELDS = new Set(["token", "sessionId", "resumeToken", "idempotencyKey", "file"])

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_RESEARCH_ATTACHMENT_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "Attachment request is too large" }, { status: 413 })
  }
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: "Invalid attachment request" }, { status: 400 })
  }
  if ([...form.keys()].some((key) => !FIELDS.has(key))) {
    return NextResponse.json({ error: "Invalid attachment request" }, { status: 400 })
  }
  const token = form.get("token")
  const sessionId = form.get("sessionId")
  const resumeToken = form.get("resumeToken")
  const idempotencyKey = form.get("idempotencyKey")
  const file = form.get("file")
  if (
    typeof token !== "string" || typeof sessionId !== "string" || typeof resumeToken !== "string" ||
    typeof idempotencyKey !== "string" || !(file instanceof File)
  ) return NextResponse.json({ error: "Invalid attachment request" }, { status: 400 })
  const resolved = await resolveActiveResearchStudy(token)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const attachment = await createParticipantResearchAttachment({
      context: resolved,
      storage: getResearchArtifactStorage(),
      sessionId,
      resumeToken,
      idempotencyKey,
      originalName: file.name,
      mimeType: file.type,
      bytes,
    })
    return NextResponse.json(attachment)
  } catch (error) {
    if (error instanceof ResearchAttachmentError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("Research attachment upload failed", error)
    return NextResponse.json({ error: "Attachment unavailable" }, { status: 502 })
  }
}
