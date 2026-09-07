import { after, NextResponse } from "next/server"
import { ResearchAgentUnavailableError, runResearchInterviewAgent } from "@/lib/research-agent"
import { resolveActiveResearchStudy } from "@/lib/research-access"
import { ResearchSessionError, respondToResearchSession } from "@/lib/research-session"
import { readBoundedResearchJson, ResearchRequestBodyError } from "@/lib/research-request"
import { getResearchArtifactStorage } from "@/lib/artifact-storage"

export const runtime = "nodejs"
export const maxDuration = 300

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
    typeof body.resumeToken !== "string" || typeof body.idempotencyKey !== "string" ||
    typeof body.answer !== "string" ||
    Object.keys(body).some((key) => !["token", "sessionId", "resumeToken", "idempotencyKey", "answer", "attachmentIds"].includes(key)) ||
    (body.attachmentIds !== undefined && !Array.isArray(body.attachmentIds))
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }
  const resolved = await resolveActiveResearchStudy(body.token)
  if (!resolved) return NextResponse.json({ error: "Study not found" }, { status: 404 })
  const sessionId = body.sessionId, resumeToken = body.resumeToken
  try {
    // Functional browser tests exercise the real persistence path without making
    // a paid model call. Production can never enter this branch.
    const functionalAgent = process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"
      ? async (input: Parameters<typeof runResearchInterviewAgent>[0]) => {
          // Guarantee overlap for the real-Postgres single-flight probe.
          input.onDelta?.("What made ")
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          input.onDelta?.("that difficult for you?")
          return "What made that difficult for you?"
        }
      : (input: Parameters<typeof runResearchInterviewAgent>[0]) => runResearchInterviewAgent(input)
    const execute = (onDelta?: (text: string) => void) => respondToResearchSession({
      context: resolved,
      sessionId,
      resumeToken,
      idempotencyKey: body.idempotencyKey,
      answer: body.answer,
      attachmentIds: body.attachmentIds ?? [],
      loadAttachmentBytes: (pathname: string) => getResearchArtifactStorage().get(pathname),
      baseUrl: new URL(request.url).origin,
      runAgent: functionalAgent,
      ...(onDelta ? { onDelta } : {}),
    })
    if (request.headers.get("accept")?.split(",").some((value) => value.trim() === "application/x-ndjson")) {
      let cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const work = (async () => {
            const emit = (frame: unknown) => {
              if (!cancelled) controller.enqueue(new TextEncoder().encode(JSON.stringify(frame) + "\n"))
            }
            let chars = 0
            try {
              const result = await execute((text) => {
                if (typeof text !== "string" || (chars += text.length) > 4_000) throw new Error("Provisional reply limit")
                emit({ type: "delta", text })
              })
              // The canonical service returns only after the final save commits.
              emit({ type: "final", result })
            } catch (error) {
              const status = error instanceof ResearchSessionError ? error.status : error instanceof ResearchAgentUnavailableError ? 503 : 502
              emit({ type: "error", status })
            } finally {
              if (!cancelled) controller.close()
            }
          })()
          // Register this same in-flight save with the platform lifetime. This
          // survives display cancellation, not maxDuration or process failure.
          after(work)
          return work
        },
        // Losing the display must not throw from a provisional observer and
        // invalidate a successful save. Reconnect reads the durable receipt.
        cancel() { cancelled = true },
      })
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } })
    }
    const result = await execute()
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof ResearchSessionError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    if (error instanceof ResearchAgentUnavailableError) {
      console.error("Research agent is not configured", error.message)
      return NextResponse.json({ error: "Interviewer is not configured" }, { status: 503 })
    }
    console.error("Research agent turn failed", error)
    return NextResponse.json({ error: "Interviewer unavailable" }, { status: 502 })
  }
}
