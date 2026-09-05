import { NextResponse } from "next/server"
import { resolveActiveResearchStudy } from "@/lib/research-access"
import { hashResearchToken } from "@/lib/research"
import { readBoundedResearchJson, ResearchRequestBodyError } from "@/lib/research-request"
import { createResearchVoiceLease, releaseResearchVoiceLease, ResearchVoiceError } from "@/lib/research-voice"
import { isResearchLegacyVoiceHarnessEnabled } from "@/lib/research-feature"

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
  if (!isResearchLegacyVoiceHarnessEnabled()) {
    return NextResponse.json({ error: "Voice is not available for this study" }, { status: 409 })
  }
  const resolved = await resolveActiveResearchStudy(body.token)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  try {
    const lease = await createResearchVoiceLease({
      context: resolved,
      sessionId: body.sessionId,
      resumeToken: body.resumeToken,
    })
    if (process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1") {
      return NextResponse.json({
        ephemeralToken: "e2e-no-provider",
        leaseId: lease.leaseId,
        leaseExpiresAt: lease.expiresAt.toISOString(),
        providerExpiresAt: null,
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
    })
    if (!provider.ok) {
      await releaseResearchVoiceLease({ context: resolved, sessionId: body.sessionId, resumeToken: body.resumeToken, leaseId: lease.leaseId })
      console.error("OpenAI Realtime credential request failed", provider.status)
      return NextResponse.json({ error: "Voice interviewer unavailable" }, { status: 502 })
    }
    const data = await provider.json() as { value?: string; expires_at?: number }
    if (!data.value) {
      await releaseResearchVoiceLease({ context: resolved, sessionId: body.sessionId, resumeToken: body.resumeToken, leaseId: lease.leaseId })
      return NextResponse.json({ error: "Voice interviewer unavailable" }, { status: 502 })
    }
    return NextResponse.json({
      ephemeralToken: data.value,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.expiresAt.toISOString(),
      providerExpiresAt: data.expires_at ?? null,
    })
  } catch (error) {
    if (error instanceof ResearchVoiceError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("Research voice session failed", error)
    return NextResponse.json({ error: "Voice interviewer unavailable" }, { status: 502 })
  }
}
