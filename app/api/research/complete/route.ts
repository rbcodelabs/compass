import { NextResponse } from "next/server"
import { resolveActiveResearchStudy } from "@/lib/research-access"

type Message = { role: "INTERVIEWER" | "PARTICIPANT"; content: string }

export async function POST(request: Request) {
  const { token, sessionId, messages } = await request.json() as { token?: string; sessionId?: string; messages?: Message[] }
  if (!token || !sessionId || !messages?.length) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  const resolved = await resolveActiveResearchStudy(token)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  const session = await resolved.prisma.researchSession.findFirst({ where: { id: sessionId, studyId: resolved.study.id, status: "IN_PROGRESS" }, select: { id: true } })
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 })
  await resolved.prisma.$transaction([resolved.prisma.researchTurn.deleteMany({ where: { sessionId } }), ...messages.map((message, sequence) => resolved.prisma.researchTurn.create({ data: { sessionId, role: message.role, content: message.content.trim(), sequence } })), resolved.prisma.researchSession.update({ where: { id: sessionId }, data: { status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() } })])
  return NextResponse.json({ ok: true })
}
