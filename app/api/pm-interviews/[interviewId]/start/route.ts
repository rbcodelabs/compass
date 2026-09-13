import { NextResponse } from "next/server"
import { readBoundedResearchJson, ResearchRequestBodyError } from "@/lib/research-request"
import { startOrResumePmInterviewVoice } from "@/lib/pm-interview-service"
import { pmRouteContext, pmRouteError } from "@/lib/pm-interview-route"

export async function POST(request: Request, { params }: { params: Promise<{ interviewId: string }> }) {
  try {
    const context = await pmRouteContext(request), { interviewId } = await params
    const body = await readBoundedResearchJson(request)
    if (Object.keys(body).some(key => !["modality", "sessionId", "resumeToken"].includes(key)) || body.modality !== "VOICE") return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    return NextResponse.json(await startOrResumePmInterviewVoice(context.scope, context.actor, interviewId, body))
  } catch (error) {
    if (error instanceof ResearchRequestBodyError) return NextResponse.json({ error: error.message }, { status: error.status })
    return pmRouteError(error)
  }
}
