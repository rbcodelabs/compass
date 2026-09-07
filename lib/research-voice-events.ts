export type FinalResearchVoiceEvent = {
  providerEventId: string
  role: "PARTICIPANT" | "INTERVIEWER"
  content: string
}

export function finalResearchVoiceEvent(event: Record<string, unknown>): FinalResearchVoiceEvent | null {
  const itemId = typeof event.item_id === "string" ? event.item_id : ""
  const transcript = typeof event.transcript === "string" ? event.transcript.trim() : ""
  if (!itemId || !transcript) return null
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    return { providerEventId: `input:${itemId}`, role: "PARTICIPANT", content: transcript }
  }
  if (event.type === "response.output_audio_transcript.done") {
    return { providerEventId: `output:${itemId}`, role: "INTERVIEWER", content: transcript }
  }
  return null
}
