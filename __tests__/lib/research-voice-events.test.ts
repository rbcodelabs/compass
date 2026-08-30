import { describe, expect, it } from "vitest"
import { finalResearchVoiceEvent } from "@/lib/research-voice-events"

describe("OpenAI Realtime finalized transcript events", () => {
  it("maps only current finalized user and moderator transcript events", () => {
    expect(finalResearchVoiceEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-user", transcript: " I expected a menu. " }))
      .toEqual({ providerEventId: "input:item-user", role: "PARTICIPANT", content: "I expected a menu." })
    expect(finalResearchVoiceEvent({ type: "response.output_audio_transcript.done", item_id: "item-ai", transcript: "What would you try next?" }))
      .toEqual({ providerEventId: "output:item-ai", role: "INTERVIEWER", content: "What would you try next?" })
  })

  it.each([
    { type: "conversation.item.input_audio_transcription.delta", item_id: "x", delta: "partial" },
    { type: "response.output_audio_transcript.delta", item_id: "x", delta: "partial" },
    { type: "response.output_audio_transcript.done", item_id: "x", transcript: "" },
    { type: "malicious.replace_transcript", transcript: "everything" },
  ])("never persists partial or replacement events", (event) => {
    expect(finalResearchVoiceEvent(event)).toBeNull()
  })
})
