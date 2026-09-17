import { NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { readBoundedResearchJson } from "@/lib/research-request"
import { generateSessionAnalysis, ResearchAnalysisError } from "@/lib/research-analysis-service"

export const maxDuration = 180
/**
 * Per-session analysis only. ADR-0012 step 6 retired the `synthesis` variant:
 * cross-session synthesis is now the core agent's `generate_research_synthesis`
 * tool, reached from the study page through /api/research/synthesis-handoff.
 */
const input = z.object({ kind: z.enum(["summary", "coverage"]), studyId: z.string().min(1).max(100), sessionId: z.string().min(1).max(100), regenerate: z.boolean().optional() }).strict()
export async function POST(request: Request) {
  if (!isResearchCaptureEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (request.headers.get("origin") !== new URL(request.url).origin) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 })
  const member = await auth()
  if (!member?.user?.id) return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  let body: z.infer<typeof input>
  try { body = input.parse(await readBoundedResearchJson(request)) }
  catch { return NextResponse.json({ error: "Invalid analysis request" }, { status: 400 }) }
  try {
    const result = await generateSessionAnalysis({ ...body, userId: member.user.id })
    return NextResponse.json({ result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof ResearchAnalysisError ? error.message : "Analysis unavailable; saved research is unchanged" }, { status: error instanceof ResearchAnalysisError ? error.status : 502 })
  }
}
