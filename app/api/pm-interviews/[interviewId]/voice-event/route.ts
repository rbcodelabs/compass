import { NextResponse } from "next/server"
import { markPmInterviewSpeechPending, pmInterviewVoiceContext } from "@/lib/pm-interview-service"
import { pmRouteContext, pmRouteError } from "@/lib/pm-interview-route"
import { readBoundedResearchJson, ResearchRequestBodyError } from "@/lib/research-request"
import { releaseResearchVoiceLease, ResearchVoiceError } from "@/lib/research-voice"
import { appendParticipantVoiceEvent } from "@/lib/research-participant-voice"

export async function POST(request: Request, { params }: { params: Promise<{ interviewId: string }> }) {
  try {
    const route = await pmRouteContext(request), body = await readBoundedResearchJson(request), { interviewId } = await params
    const base = ["sessionId", "resumeToken", "leaseId", "action"]
    if (base.some(key => typeof body[key] !== "string") || !["FINAL", "DISCONNECT", "SPEECH_START"].includes(body.action as string)) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    const allowed = new Set(base); if (body.action === "FINAL") ["clientEventId", "reportedOrdinal", "role", "content", "speechId"].forEach(key => allowed.add(key)); if (body.action === "SPEECH_START") allowed.add("speechId")
    if (Object.keys(body).some(key => !allowed.has(key))) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    if (body.action === "SPEECH_START") return NextResponse.json(await markPmInterviewSpeechPending(route.scope, route.actor, interviewId, { leaseId: body.leaseId, speechId: body.speechId }))
    const context = await pmInterviewVoiceContext(route.scope, route.actor, interviewId)
    if (body.action === "DISCONNECT") return NextResponse.json(await releaseResearchVoiceLease({ context, sessionId: body.sessionId as string, resumeToken: body.resumeToken as string, leaseId: body.leaseId as string }))
    if (typeof body.clientEventId !== "string" || typeof body.reportedOrdinal !== "number" || typeof body.content !== "string" || (body.role !== "PARTICIPANT" && body.role !== "INTERVIEWER")) return NextResponse.json({ error: "Invalid participant voice event" }, { status: 400 })
    return NextResponse.json(await appendParticipantVoiceEvent({ context, sessionId: body.sessionId as string, resumeToken: body.resumeToken as string, leaseId: body.leaseId as string, clientEventId: body.clientEventId, reportedOrdinal: body.reportedOrdinal, role: body.role, content: body.content, speechId: typeof body.speechId === "string" ? body.speechId : undefined }))
  } catch (error) {
    if (error instanceof ResearchRequestBodyError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (error instanceof ResearchVoiceError) return NextResponse.json({ error: error.message }, { status: error.status })
    return pmRouteError(error)
  }
}
