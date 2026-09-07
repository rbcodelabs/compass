import { NextResponse } from "next/server"
import { resolveActiveResearchStudy } from "@/lib/research-access"
import { readBoundedResearchJson, ResearchRequestBodyError } from "@/lib/research-request"
import { appendFinalResearchVoiceEvent, releaseResearchVoiceLease, ResearchVoiceError } from "@/lib/research-voice"
import { isResearchBrowserVoiceEnabled, isResearchParticipantVoiceEnabled } from "@/lib/research-feature"
import { appendParticipantVoiceEvent } from "@/lib/research-participant-voice"

const BASE_KEYS = ["token", "sessionId", "resumeToken", "leaseId", "action"] as const

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await readBoundedResearchJson(request)
  } catch (error) {
    const status = error instanceof ResearchRequestBodyError ? error.status : 400
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status })
  }
  if (
    BASE_KEYS.some((key) => typeof body[key] !== "string") ||
    (body.action !== "FINAL" && body.action !== "DISCONNECT")
  ) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  const allowed = new Set<string>(BASE_KEYS)
  if (body.action === "FINAL") [...(isResearchBrowserVoiceEnabled() ? ["clientEventId", "reportedOrdinal"] : ["providerEventId"]), "role", "content", "attachmentId"].forEach((key) => allowed.add(key))
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }
  if (!isResearchParticipantVoiceEnabled()) {
    return NextResponse.json({ error: "Voice is not available for this study" }, { status: 409 })
  }
  const resolved = await resolveActiveResearchStudy(body.token as string)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  try {
    if (body.action === "DISCONNECT") {
      return NextResponse.json(await releaseResearchVoiceLease({
        context: resolved,
        sessionId: body.sessionId as string,
        resumeToken: body.resumeToken as string,
        leaseId: body.leaseId as string,
      }))
    }
    if (isResearchBrowserVoiceEnabled()) {
      if (typeof body.clientEventId !== "string" || typeof body.reportedOrdinal !== "number" || typeof body.content !== "string" ||
        (body.role !== "PARTICIPANT" && body.role !== "INTERVIEWER") || (body.attachmentId !== undefined && typeof body.attachmentId !== "string")) return NextResponse.json({ error: "Invalid participant voice event" }, { status: 400 })
      return NextResponse.json(await appendParticipantVoiceEvent({ context: resolved, sessionId: body.sessionId as string, resumeToken: body.resumeToken as string, leaseId: body.leaseId as string, clientEventId: body.clientEventId, reportedOrdinal: body.reportedOrdinal, role: body.role, content: body.content, ...(typeof body.attachmentId === "string" ? { attachmentId: body.attachmentId } : {}) }))
    }
    if (typeof body.providerEventId !== "string" || typeof body.content !== "string" ||
      (body.role !== "PARTICIPANT" && body.role !== "INTERVIEWER") ||
      (body.attachmentId !== undefined && typeof body.attachmentId !== "string")) {
      return NextResponse.json({ error: "Invalid finalized voice event" }, { status: 400 })
    }
    return NextResponse.json(await appendFinalResearchVoiceEvent({
      context: resolved,
      sessionId: body.sessionId as string,
      resumeToken: body.resumeToken as string,
      leaseId: body.leaseId as string,
      providerEventId: body.providerEventId,
      role: body.role,
      content: body.content,
      ...(typeof body.attachmentId === "string" ? { attachmentId: body.attachmentId } : {}),
    }))
  } catch (error) {
    if (error instanceof ResearchVoiceError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("Research voice event failed", error)
    return NextResponse.json({ error: "Voice transcript unavailable" }, { status: 502 })
  }
}
