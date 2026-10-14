import { handleAgentRunCallback } from "@/lib/agent-run-callback"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return handleAgentRunCallback(request, (await context.params).runId, "events")
}
