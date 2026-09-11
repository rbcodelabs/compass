import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { pmInterviewVoiceContext } from "@/lib/pm-interview-service"
import { pmRouteContext, pmRouteError } from "@/lib/pm-interview-route"
import { readBoundedResearchJson, ResearchRequestBodyError } from "@/lib/research-request"
import { createResearchVoiceLease, releaseResearchVoiceLease, ResearchVoiceError } from "@/lib/research-voice"
import { isResearchBrowserVoiceEnabled, isResearchParticipantVoiceEnabled } from "@/lib/research-feature"
import { verifyParticipantVoiceLease } from "@/lib/research-participant-voice"

export async function POST(request: Request, { params }: { params: Promise<{ interviewId: string }> }) {
  let claimedLeaseId: string | null = null
  let voiceContext: Awaited<ReturnType<typeof pmInterviewVoiceContext>> | null = null
  let sessionInput: { sessionId: string; resumeToken: string } | null = null
  try {
    const route = await pmRouteContext(request), { interviewId } = await params, body = await readBoundedResearchJson(request)
    if (Object.keys(body).some(key => !["sessionId", "resumeToken"].includes(key)) || typeof body.sessionId !== "string" || typeof body.resumeToken !== "string") return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    if (!isResearchParticipantVoiceEnabled() || !isResearchBrowserVoiceEnabled()) return NextResponse.json({ error: "Voice is not available for this interview" }, { status: 409 })
    const context = await pmInterviewVoiceContext(route.scope, route.actor, interviewId)
    voiceContext = context
    sessionInput = { sessionId: body.sessionId, resumeToken: body.resumeToken }
    const lease = await createResearchVoiceLease({ context, sessionId: body.sessionId, resumeToken: body.resumeToken })
    claimedLeaseId = lease.leaseId
    if (process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1") return NextResponse.json({ ephemeralToken: "e2e-no-provider", leaseId: lease.leaseId, leaseExpiresAt: lease.expiresAt.toISOString(), providerExpiresAt: null, evidenceMode: "PARTICIPANT_SUBMITTED", targetMinutes: context.study.targetMinutes })
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new ResearchVoiceError("Voice interviewer is not configured", 503)
    const provider = await fetch("https://api.openai.com/v1/realtime/client_secrets", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "OpenAI-Safety-Identifier": createHash("sha256").update(interviewId).digest("hex") }, body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 60 }, session: { type: "realtime", model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime", instructions: lease.instructions, tools: [], audio: { input: { turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true }, transcription: { model: process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe" } }, output: { voice: process.env.OPENAI_REALTIME_VOICE || "alloy" } } } }), cache: "no-store", signal: AbortSignal.timeout(15_000) })
    if (!provider.ok) throw new ResearchVoiceError("Voice interviewer unavailable", 502)
    const data = await provider.json() as { value?: string; expires_at?: number }
    if (!data.value || typeof data.expires_at !== "number" || data.expires_at <= Date.now() / 1000) throw new ResearchVoiceError("Voice interviewer unavailable", 502)
    await verifyParticipantVoiceLease({ context, sessionId: body.sessionId, resumeToken: body.resumeToken, leaseId: lease.leaseId })
    return NextResponse.json({ ephemeralToken: data.value, leaseId: lease.leaseId, leaseExpiresAt: lease.expiresAt.toISOString(), providerExpiresAt: data.expires_at, evidenceMode: "PARTICIPANT_SUBMITTED", targetMinutes: context.study.targetMinutes }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    try {
      if (claimedLeaseId && voiceContext && sessionInput) await releaseResearchVoiceLease({ context: voiceContext, ...sessionInput, leaseId: claimedLeaseId })
    } catch { console.error("PM voice credential lease compensation failed") }
    if (error instanceof ResearchRequestBodyError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (error instanceof ResearchVoiceError) return NextResponse.json({ error: error.message }, { status: error.status })
    return pmRouteError(error)
  }
}
