import { handleAgentSessionUpload } from "@/lib/agent-session-callback"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return handleAgentSessionUpload(request, (await context.params).runId)
}
