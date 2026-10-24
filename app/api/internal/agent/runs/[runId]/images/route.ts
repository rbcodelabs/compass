import { handleAgentImageUpload } from "@/lib/agent-image-callback"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return handleAgentImageUpload(request, (await context.params).runId)
}
