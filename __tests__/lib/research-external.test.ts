import { describe, expect, it } from "vitest"
import {
  EXTERNAL_PROVIDERS,
  ExternalResearchInputError,
  MAX_EXTERNAL_NOTES_CHARS,
  MAX_EXTERNAL_TRANSCRIPT_CHARS,
  deterministicExternalSessionId,
  normalizeExternalStudyInput,
  normalizeExternalSessionInput,
  parseExternalTranscript,
} from "@/lib/research-external"

describe("normalizeExternalStudyInput", () => {
  it("accepts a provider and https url and trims the name and goal", () => {
    expect(normalizeExternalStudyInput({ name: "  Onboarding test ", goal: " Learn things ", externalProvider: "USERTESTING", externalUrl: "https://app.usertesting.com/study/1#frag" })).toEqual({
      name: "Onboarding test", goal: "Learn things", externalProvider: "USERTESTING", externalUrl: "https://app.usertesting.com/study/1",
    })
  })

  it("treats a blank url as absent", () => {
    expect(normalizeExternalStudyInput({ name: "a", goal: "b", externalProvider: "OTHER", externalUrl: "  " }).externalUrl).toBeNull()
  })

  it.each([
    [{ name: "", goal: "g", externalProvider: "MAZE" }],
    [{ name: "n", goal: "", externalProvider: "MAZE" }],
    [{ name: "x".repeat(256), goal: "g", externalProvider: "MAZE" }],
    [{ name: "n", goal: "g".repeat(5_001), externalProvider: "MAZE" }],
    [{ name: "n", goal: "g", externalProvider: "SURVEYMONKEY" }],
    [{ name: "n", goal: "g", externalProvider: undefined }],
    [{ name: "n", goal: "g", externalProvider: "MAZE", externalUrl: "javascript:alert(1)" }],
    [{ name: "n", goal: "g", externalProvider: "MAZE", externalUrl: "http://insecure.example.com" }],
    [{ name: "n", goal: "g", externalProvider: "MAZE", externalUrl: "https://user:pw@example.com" }],
    [{ name: "n", goal: "g", externalProvider: "MAZE", externalUrl: "https://localhost/x" }],
  ])("rejects invalid study input %#", (input) => {
    expect(() => normalizeExternalStudyInput(input as never)).toThrow(ExternalResearchInputError)
  })

  it("exposes the supported providers", () => {
    expect([...EXTERNAL_PROVIDERS]).toEqual(["USERTESTING", "MAZE", "OTHER"])
  })
})

describe("parseExternalTranscript", () => {
  it("maps speaker labels to roles and merges continuation lines", () => {
    expect(parseExternalTranscript("Interviewer: How do you start?\nParticipant: I open the app.\nThen I scroll.\nModerator: Why?\nP1: Habit.")).toEqual([
      { role: "INTERVIEWER", content: "How do you start?" },
      { role: "PARTICIPANT", content: "I open the app.\nThen I scroll." },
      { role: "INTERVIEWER", content: "Why?" },
      { role: "PARTICIPANT", content: "Habit." },
    ])
  })

  it("accepts leading timestamps before the label", () => {
    expect(parseExternalTranscript("[00:12] Interviewer: Hi\n00:20 Participant: Hello")).toEqual([
      { role: "INTERVIEWER", content: "Hi" },
      { role: "PARTICIPANT", content: "Hello" },
    ])
  })

  it("treats an unlabeled transcript as participant paragraphs", () => {
    expect(parseExternalTranscript("First thought.\n\nSecond thought.")).toEqual([
      { role: "PARTICIPANT", content: "First thought." },
      { role: "PARTICIPANT", content: "Second thought." },
    ])
  })

  it("does not split a sentence on an incidental colon", () => {
    expect(parseExternalTranscript("Participant: The problem is: it is slow.")).toEqual([{ role: "PARTICIPANT", content: "The problem is: it is slow." }])
  })

  it("splits very long turns so each stays within the turn limit", () => {
    const turns = parseExternalTranscript(`Participant: ${"word ".repeat(2_000)}`)
    expect(turns.length).toBeGreaterThan(1)
    for (const turn of turns) {
      expect(turn.role).toBe("PARTICIPANT")
      expect(turn.content.length).toBeLessThanOrEqual(4_000)
    }
  })

  it("returns no turns for blank text", () => {
    expect(parseExternalTranscript("  \n ")).toEqual([])
  })
})

describe("normalizeExternalSessionInput", () => {
  const base = { idempotencyKey: "test-idempotency-key-0001" }

  it("requires a transcript or notes", () => {
    expect(() => normalizeExternalSessionInput({ ...base })).toThrow("Add a transcript or notes")
  })

  it("accepts notes only, producing no turns", () => {
    const result = normalizeExternalSessionInput({ ...base, notes: " Users liked it " })
    expect(result.turns).toEqual([])
    expect(result.notes).toBe("Users liked it")
  })

  it("parses a transcript, normalizes optional participant details, link and date", () => {
    const result = normalizeExternalSessionInput({
      ...base, transcript: "Participant: Hi", participantName: " Sam ", participantEmail: "Sam@Example.com ",
      externalUrl: "https://example.com/s/1", sessionDate: "2026-09-30",
    })
    expect(result).toMatchObject({ participantName: "Sam", participantEmail: "sam@example.com", externalUrl: "https://example.com/s/1" })
    expect(result.turns).toEqual([{ role: "PARTICIPANT", content: "Hi" }])
    expect(result.sessionDate.toISOString()).toBe("2026-09-30T00:00:00.000Z")
  })

  it("defaults the date to now when blank", () => {
    const before = Date.now()
    const { sessionDate } = normalizeExternalSessionInput({ ...base, notes: "n", sessionDate: "" })
    expect(sessionDate.getTime()).toBeGreaterThanOrEqual(before)
  })

  it.each([
    [{ transcript: "x".repeat(MAX_EXTERNAL_TRANSCRIPT_CHARS + 1) }],
    [{ notes: "x".repeat(MAX_EXTERNAL_NOTES_CHARS + 1) }],
    [{ notes: "n", participantName: "x".repeat(256) }],
    [{ notes: "n", participantEmail: "not-an-email" }],
    [{ notes: "n", sessionDate: "yesterday" }],
    [{ notes: "n", sessionDate: "2999-01-01" }],
    [{ notes: "n", externalUrl: "ftp://example.com/x" }],
    [{ notes: "n", idempotencyKey: "short" }],
  ])("rejects invalid session input %#", (input) => {
    expect(() => normalizeExternalSessionInput({ ...base, ...input } as never)).toThrow(ExternalResearchInputError)
  })

  it("rejects transcripts with more than 500 turns", () => {
    const transcript = Array.from({ length: 501 }, (_, i) => `Participant: line ${i}`).join("\n")
    expect(() => normalizeExternalSessionInput({ ...base, transcript })).toThrow("at most 500 turns")
  })
})

describe("deterministicExternalSessionId", () => {
  it("is stable per study + key, uuid-shaped and distinct across inputs", () => {
    const a = deterministicExternalSessionId("study-1", "key-aaaaaaaaaaaaaaaa")
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(deterministicExternalSessionId("study-1", "key-aaaaaaaaaaaaaaaa")).toBe(a)
    expect(deterministicExternalSessionId("study-2", "key-aaaaaaaaaaaaaaaa")).not.toBe(a)
    expect(deterministicExternalSessionId("study-1", "key-bbbbbbbbbbbbbbbb")).not.toBe(a)
  })
})
