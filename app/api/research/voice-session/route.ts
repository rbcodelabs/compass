import { NextResponse } from "next/server"
import { resolveActiveResearchStudy } from "@/lib/research-access"
import { hashResearchToken } from "@/lib/research"
import { readBoundedResearchJson, ResearchRequestBodyError } from "@/lib/research-request"
import { createResearchVoiceLease, releaseResearchVoiceLease, ResearchVoiceError } from "@/lib/research-voice"
import { isResearchBrowserVoiceEnabled, isResearchParticipantVoiceEnabled } from "@/lib/research-feature"
import { verifyParticipantVoiceLease } from "@/lib/research-participant-voice"

export const runtime = "nodejs"

const ALLOWED_KEYS = new Set(["token", "sessionId", "resumeToken"])

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await readBoundedResearchJson(request)
  } catch (error) {
    const status = error instanceof ResearchRequestBodyError ? error.status : 400
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status })
  }
  if (
    Object.keys(body).some((key) => !ALLOWED_KEYS.has(key)) ||
    typeof body.token !== "string" || typeof body.sessionId !== "string" || typeof body.resumeToken !== "string"
  ) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  if (!isResearchParticipantVoiceEnabled()) {
    return NextResponse.json({ error: "Voice is not available for this study" }, { status: 409 })
  }
  const resolved = await resolveActiveResearchStudy(body.token)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  let claimedLeaseId: string | null = null
  try {
    const lease = await createResearchVoiceLease({
      context: resolved,
      sessionId: body.sessionId,
      resumeToken: body.resumeToken,
    })
    claimedLeaseId = lease.leaseId
    if (process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1") {
      return NextResponse.json({
        ephemeralToken: "e2e-no-provider",
        leaseId: lease.leaseId,
        leaseExpiresAt: lease.expiresAt.toISOString(),
        providerExpiresAt: null,
        evidenceMode: isResearchBrowserVoiceEnabled() ? "PARTICIPANT_SUBMITTED" : "LEGACY_HARNESS",
        targetMinutes: resolved.study.targetMinutes,
      })
    }
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      await releaseResearchVoiceLease({ context: resolved, sessionId: body.sessionId, resumeToken: body.resumeToken, leaseId: lease.leaseId })
      return NextResponse.json({ error: "Voice interviewer is not configured" }, { status: 503 })
    }
    const provider = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": hashResearchToken(body.token),
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 60 },
        session: {
          type: "realtime",
          model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
          instructions: lease.instructions,
          tools: [],
          audio: {
            input: {
              transcription: {
                model: process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe",
              },
            },
            output: { voice: process.env.OPENAI_REALTIME_VOICE || "alloy" },
          },
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
    if (!provider.ok) {
      await releaseResearchVoiceLease({ context: resolved, sessionId: body.sessionId, resumeToken: body.resumeToken, leaseId: lease.leaseId })
      console.error("OpenAI Realtime credential request failed", provider.status)
      return NextResponse.json({ error: "Voice interviewer unavailable" }, { status: 502 })
    }
    const data = await provider.json() as { value?: string; expires_at?: number }
    if (typeof data.value !== "string" || !data.value || typeof data.expires_at !== "number" || data.expires_at <= Date.now() / 1000) {
      await releaseResearchVoiceLease({ context: resolved, sessionId: body.sessionId, resumeToken: body.resumeToken, leaseId: lease.leaseId })
      return NextResponse.json({ error: "Voice interviewer unavailable" }, { status: 502 })
    }
    await verifyParticipantVoiceLease({ context: resolved, sessionId: body.sessionId, resumeToken: body.resumeToken, leaseId: lease.leaseId })
    return NextResponse.json({
      ephemeralToken: data.value,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.expiresAt.toISOString(),
      providerExpiresAt: data.expires_at ?? null,
      evidenceMode: "PARTICIPANT_SUBMITTED",
      targetMinutes: resolved.study.targetMinutes,
    }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (claimedLeaseId) {
      try {
        await releaseResearchVoiceLease({ context: resolved, sessionId: body.sessionId, resumeToken: body.resumeToken, leaseId: claimedLeaseId })
      } catch {
        // A failed compensation leaves the bounded lease in place; never claim release.
        console.error("Research voice credential lease compensation failed")
      }
    }
    if (error instanceof ResearchVoiceError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("Research voice session failed", error)
    return NextResponse.json({ error: "Voice interviewer unavailable" }, { status: 502 })
  }
}
