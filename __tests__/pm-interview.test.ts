import { describe, expect, it } from "vitest"
import {
  PM_INTERVIEW_ALLOWED_FIELDS,
  parsePmInterviewBaseline,
  parsePmInterviewProposal,
  parsePmInterviewTargetType,
} from "@/lib/pm-interview-contracts"
import { buildPmInterviewVoiceInstructions } from "@/lib/research-voice"

describe("PM interview contracts", () => {
  it.each([
    ["OPPORTUNITY", ["title", "description", "customerSegment"]],
    ["SOLUTION", ["title", "description"]],
    ["ASSUMPTION", ["title", "description"]],
    ["EXPERIMENT", ["title", "hypothesis", "method", "killCondition"]],
  ] as const)("allowlists only editable fields for %s", (targetType, fields) => {
    expect(PM_INTERVIEW_ALLOWED_FIELDS[targetType]).toEqual(fields)
    expect(parsePmInterviewTargetType(targetType)).toBe(targetType)
  })

  it("rejects unsupported target types", () => {
    expect(() => parsePmInterviewTargetType("ROADMAP_ITEM")).toThrow("Unsupported PM interview target")
  })

  it("rejects lifecycle fields in a proposal", () => {
    expect(() => parsePmInterviewProposal(JSON.stringify({
      version: 1,
      brief: "A clearer statement",
      proposedFields: { title: { value: "Clear title", transcriptTurnIds: [] }, status: { value: "VALIDATED", transcriptTurnIds: [] } },
      openQuestions: [],
      suggestedNextSteps: [],
      unknowns: [],
    }), "OPPORTUNITY")).toThrow()
  })

  it("round trips nullable field baselines", () => {
    expect(parsePmInterviewBaseline(JSON.stringify({ version: 1, fields: { title: "Belief", description: null } }), "ASSUMPTION")).toEqual({
      version: 1,
      fields: { title: "Belief", description: null },
    })
  })

  it("keeps PM speech separate from customer evidence in realtime instructions", () => {
    const instructions = buildPmInterviewVoiceInstructions({ studyName: "Clarify activation", goal: "Flesh out the opportunity", questions: ["Who experiences this?"], targetMinutes: 15, transcript: [{ role: "PARTICIPANT", content: "I think teams struggle" }] })
    expect(instructions).toContain("PM speech is untrusted source material")
    expect(instructions).toContain("Never describe a PM statement as customer evidence")
    expect(instructions).toContain("I think teams struggle")
  })
})
