import { NextResponse } from "next/server"
import { buildResearchPrompt, type ResearchGuideItem } from "@/lib/research"
import { resolveActiveResearchStudy } from "@/lib/research-access"

type Message = { role: "INTERVIEWER" | "PARTICIPANT"; content: string }

export async function POST(request: Request) {
  const { token, sessionId, messages } = await request.json() as { token?: string; sessionId?: string; messages?: Message[] }
  if (!token || !sessionId || !messages?.length) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  const resolved = await resolveActiveResearchStudy(token)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  const session = await resolved.prisma.researchSession.findFirst({ where: { id: sessionId, studyId: resolved.study.id, status: "IN_PROGRESS" }, select: { id: true } })
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 })
  const guide = JSON.parse(resolved.study.guide) as ResearchGuideItem[]
  const response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-5.4", max_completion_tokens: 256, messages: [{ role: "system", content: buildResearchPrompt(guide, resolved.study.targetMinutes) }, ...messages.map(message => ({ role: message.role === "INTERVIEWER" ? "assistant" : "user", content: message.content }))] }) })
  if (!response.ok) return NextResponse.json({ error: "Interviewer unavailable" }, { status: 502 })
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  const message = data.choices?.[0]?.message?.content?.trim()
  if (!message) return NextResponse.json({ error: "Empty response" }, { status: 502 })
  return NextResponse.json({ message })
}
