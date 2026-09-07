import { handleResearchVoiceCallback } from "@/lib/research-voice-callback"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ callId: string }> }) {
  return handleResearchVoiceCallback(request, (await context.params).callId, "result")
}
