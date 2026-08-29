import { NextResponse } from "next/server"
import { buildResearchAgentTurnPrompt, type ResearchGuideItem } from "@/lib/research"
import { ResearchAgentUnavailableError, runResearchInterviewAgent } from "@/lib/research-agent"
import { resolveActiveResearchStudy } from "@/lib/research-access"

export const runtime = "nodejs"
export const maxDuration = 300

type Message = { role: "INTERVIEWER" | "PARTICIPANT"; content: string }

export async function POST(request: Request) {
  const { token, sessionId, messages, elapsedSeconds } = await request.json() as {
    token?: string
    sessionId?: string
    messages?: Message[]
    elapsedSeconds?: number
  }
  if (!token || !sessionId || !messages?.length) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  const resolved = await resolveActiveResearchStudy(token)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  const session = await resolved.prisma.researchSession.findFirst({
    where: { id: sessionId, studyId: resolved.study.id, status: "IN_PROGRESS" },
    select: { id: true },
  })
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 })
  if (!resolved.study.createdById) {
    return NextResponse.json({ error: "Interviewer is not configured" }, { status: 503 })
  }

  const guide = JSON.parse(resolved.study.guide) as ResearchGuideItem[]
  const prompt = buildResearchAgentTurnPrompt({
    guide,
    targetMinutes: resolved.study.targetMinutes,
    goal: resolved.study.goal,
    elapsedSeconds,
    workspaceId: resolved.study.workspaceId,
    messages,
  })

  try {
    const message = await runResearchInterviewAgent({
      userId: resolved.study.createdById,
      workspaceId: resolved.study.workspaceId,
      prompt,
      baseUrl: new URL(request.url).origin,
    })
    return NextResponse.json({ message })
  } catch (error) {
    if (error instanceof ResearchAgentUnavailableError) {
      console.error("Research agent is not configured", error.message)
      return NextResponse.json({ error: "Interviewer is not configured" }, { status: 503 })
    }
    console.error("Research agent turn failed", error)
    return NextResponse.json({ error: "Interviewer unavailable" }, { status: 502 })
  }
}
