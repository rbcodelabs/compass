import { handleAgentDocsReconcile } from "@/lib/agent-docs-callback"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return handleAgentDocsReconcile(request, (await context.params).runId)
}
