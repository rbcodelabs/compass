import { NextResponse } from "next/server"
import { resolveActiveResearchStudy } from "@/lib/research-access"
import { ResearchSessionError, startOrResumeResearchSession } from "@/lib/research-session"
import { readBoundedResearchJson, ResearchRequestBodyError } from "@/lib/research-request"

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await readBoundedResearchJson(request)
  } catch (error) {
    const status = error instanceof ResearchRequestBodyError ? error.status : 400
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status })
  }
  if (!body || typeof body.token !== "string" || !body.token) {
    return NextResponse.json({ error: "Token required" }, { status: 400 })
  }
  const hasResume = body.sessionId !== undefined || body.resumeToken !== undefined
  if (hasResume && (typeof body.sessionId !== "string" || typeof body.resumeToken !== "string")) {
    return NextResponse.json({ error: "Both session and resume token are required" }, { status: 400 })
  }
  const resolved = await resolveActiveResearchStudy(body.token)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  try {
    const result = await startOrResumeResearchSession(
      resolved,
      hasResume ? { sessionId: body.sessionId as string, resumeToken: body.resumeToken as string } : undefined,
    )
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof ResearchSessionError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("Research session start failed", error)
    return NextResponse.json({ error: "Interview unavailable" }, { status: 502 })
  }
}
