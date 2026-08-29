import { NextResponse } from "next/server"
import { resolveActiveResearchStudy } from "@/lib/research-access"
import type { ResearchGuideItem } from "@/lib/research"

export async function POST(request: Request) {
  const { token } = await request.json() as { token?: string }
  if (!token) return NextResponse.json({ error: "Token required" }, { status: 400 })
  const resolved = await resolveActiveResearchStudy(token)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  const session = await resolved.prisma.researchSession.create({ data: { studyId: resolved.study.id, modality: "CHAT", status: "IN_PROGRESS", startedAt: new Date() } })
  const guide = JSON.parse(resolved.study.guide) as ResearchGuideItem[]
  const message = `Thanks for taking part. This should take about ${resolved.study.targetMinutes} minutes. ${guide[0]?.text ?? "Tell me about your experience."}`
  return NextResponse.json({ sessionId: session.id, message })
}
