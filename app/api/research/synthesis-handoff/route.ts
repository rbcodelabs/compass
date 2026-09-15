import { NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { readBoundedResearchJson } from "@/lib/research-request"
import { ResearchAnalysisError } from "@/lib/research-analysis-service"
import { startStudySynthesisHandoff } from "@/lib/research-synthesis-handoff"

// Opens the linked core-agent conversation for "Generate synthesis" (ADR-0012
// step 4). Same trust boundary as /api/research/analysis: session auth enforced
// here because lib/route-access.ts exempts /api/research/* from the middleware,
// plus a same-origin check because this is a state-creating POST.
// `.uuid()` rather than the legacy analysis route's min(1).max(100): ResearchStudy.id
// is @db.Uuid, so a malformed id there reaches Prisma and surfaces as a 502 instead
// of a 400. New surface, so it gets the correct bound.
const input = z.object({ studyId: z.string().uuid() }).strict()

export async function POST(request: Request) {
  if (!isResearchCaptureEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (request.headers.get("origin") !== new URL(request.url).origin) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 })
  const member = await auth()
  if (!member?.user?.id) return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  let body: z.infer<typeof input>
  try { body = input.parse(await readBoundedResearchJson(request)) }
  catch { return NextResponse.json({ error: "Invalid synthesis request" }, { status: 400 }) }
  try {
    return NextResponse.json(await startStudySynthesisHandoff(body.studyId, member.user.id))
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof ResearchAnalysisError ? error.message : "Synthesis could not be started; saved research is unchanged" },
      { status: error instanceof ResearchAnalysisError ? error.status : 502 },
    )
  }
}
