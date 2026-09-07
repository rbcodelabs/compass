import { after, NextResponse } from "next/server"
import { generateSessionAnalysis } from "@/lib/research-analysis-service"
import { resolveActiveResearchStudy } from "@/lib/research-access"
import { completeResearchSession, ResearchSessionError } from "@/lib/research-session"
import { readBoundedResearchJson, ResearchRequestBodyError } from "@/lib/research-request"

export const maxDuration = 180

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await readBoundedResearchJson(request)
  } catch (error) {
    const status = error instanceof ResearchRequestBodyError ? error.status : 400
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status })
  }
  if (
    !body || typeof body.token !== "string" || typeof body.sessionId !== "string" ||
    typeof body.resumeToken !== "string" || "messages" in body
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }
  const resolved = await resolveActiveResearchStudy(body.token)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  try {
    const result = await completeResearchSession(resolved, body.sessionId, body.resumeToken)
    const sessionId = body.sessionId
    // Completion is already durable. Neither scheduling nor analysis failure can undo it.
    try {
      after(async () => {
        try { await generateSessionAnalysis({ studyId: resolved.study.id, sessionId, kind: "summary", automatic: true }) }
        catch { console.error("Research summary unavailable; researcher retry remains available") }
      })
    } catch { console.error("Research summary scheduling unavailable") }
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof ResearchSessionError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("Research session completion failed", error)
    return NextResponse.json({ error: "Interview unavailable" }, { status: 502 })
  }
}
