import { describe, expect, it } from "vitest"
import { analysisFingerprint, parseAnalysisResult, readSessionAnalysis, buildAnalysisPrompt, parseResearchPage } from "@/lib/research-analysis"

const source = { goal: "Understand onboarding", guide: [{ id: "q1", text: "What happened?" }], sessions: [{ id: "s1", modality: "VOICE", turns: [{ id: "t1", role: "PARTICIPANT", content: "I had to ask a colleague", sequence: 1 }] }] }
describe("research analysis contracts", () => {
  it("validates summary and binds it to the saved source", () => {
    const result = parseAnalysisResult("summary", JSON.stringify({ summary: "Needed help.", evidenceTurnIds: ["t1"] }), source)
    expect(result).toMatchObject({ version: 1, kind: "summary", sourceFingerprint: analysisFingerprint(source), summary: "Needed help." })
  })
  it("rejects fabricated summary references", () => {
    expect(() => parseAnalysisResult("summary", JSON.stringify({ summary: "Help", evidenceTurnIds: ["foreign"] }), source)).toThrow()
  })
  it("requires all guide items exactly once in coverage", () => {
    expect(() => parseAnalysisResult("coverage", JSON.stringify({ coverage: [] }), source)).toThrow()
    expect(() => parseAnalysisResult("coverage", JSON.stringify({ coverage: [{ guideItemId: "q1", covered: true, evidenceTurnIds: [] }] }), source)).toThrow()
    expect(parseAnalysisResult("coverage", JSON.stringify({ coverage: [{ guideItemId: "q1", covered: true, evidenceTurnIds: ["t1"] }] }), source)).toMatchObject({ kind: "coverage" })
  })
  it("rejects unknown guide IDs and interviewer-only coverage evidence", () => {
    expect(() => parseAnalysisResult("coverage", JSON.stringify({ coverage: [{ guideItemId: "unknown", covered: false, evidenceTurnIds: [] }] }), source)).toThrow()
    const interviewer = { ...source, sessions: [{ ...source.sessions[0], turns: [{ ...source.sessions[0].turns[0], role: "INTERVIEWER" }] }] }
    expect(() => parseAnalysisResult("coverage", JSON.stringify({ coverage: [{ guideItemId: "q1", covered: true, evidenceTurnIds: ["t1"] }] }), interviewer)).toThrow()
  })
  it("accepts only verbatim participant quotes with the correct session and turn", () => {
    const content = { summary: "Needs help", themes: [{ title: "Assisted onboarding", description: "Help needed", surprising: true, quotes: [{ sessionId: "s1", turnId: "t1", text: "ask a colleague" }] }], patterns: [], jobs: [{ job: "Get started", context: "Onboarding", evidenceTurnIds: ["t1"] }], recommendations: [{ text: "Test onboarding instructions", evidenceTurnIds: ["t1"] }] }
    expect(parseAnalysisResult("synthesis", JSON.stringify(content), source)).toMatchObject({ kind: "synthesis" })
    content.themes[0].quotes[0].text = "invented quote"
    expect(() => parseAnalysisResult("synthesis", JSON.stringify(content), source)).toThrow()
  })
  it("requires cross-session patterns to cite at least two sessions", () => {
    const content = { summary: "Help", themes: [], patterns: [{ text: "Everyone needs help", evidenceTurnIds: ["t1"] }], jobs: [], recommendations: [] }
    expect(() => parseAnalysisResult("synthesis", JSON.stringify(content), source)).toThrow()
  })
  it("changes fingerprints when guide, content or modality changes", () => {
    const original = analysisFingerprint(source)
    expect(analysisFingerprint({ ...source, goal: "Other goal" })).not.toBe(original)
    expect(analysisFingerprint({ ...source, sessions: [{ ...source.sessions[0], modality: "CHAT" }] })).not.toBe(original)
  })
  it("preserves legacy plaintext summaries but rejects unknown versioned payloads", () => {
    expect(readSessionAnalysis("A legacy summary")).toEqual({ summary: "A legacy summary" })
    expect(readSessionAnalysis('"A quoted legacy summary"')).toEqual({ summary: '"A quoted legacy summary"' })
    expect(readSessionAnalysis('{"version":99,"summary":"unsafe"}')).toEqual({})
    expect(readSessionAnalysis(null)).toEqual({})
  })
  it("rejects corrupt persisted envelope metadata before rendering", () => {
    const summary = parseAnalysisResult("summary", '{"summary":"Safe text","evidenceTurnIds":["t1"]}', source)
    expect(readSessionAnalysis(JSON.stringify({ version: 1, summary: { ...summary, generatedAt: "not-a-date" } })).summary).toBeUndefined()
    expect(readSessionAnalysis(JSON.stringify({ version: 1, summary: { ...summary, sourceFingerprint: "not-a-hash" } })).summary).toBeUndefined()
  })
  it("treats saved input and browser voice evidence as untrusted, without workspace tools", () => {
    const prompt = buildAnalysisPrompt("summary", source)
    expect(prompt).toContain("untrusted")
    expect(prompt).toContain("browser-reported")
    expect(prompt).toContain("t1")
  })
  it("bounds output and rejects oversized input explicitly instead of truncating", () => {
    expect(() => parseAnalysisResult("summary", "x".repeat(100_001), source)).toThrow()
    expect(() => buildAnalysisPrompt("summary", { ...source, goal: "x".repeat(500_001) })).toThrow(/too large/)
  })
  it("normalizes pagination without negative or infinite offsets", () => {
    expect(parseResearchPage(undefined)).toBe(1)
    expect(parseResearchPage("-2")).toBe(1)
    expect(parseResearchPage("Infinity")).toBe(1)
    expect(parseResearchPage("2")).toBe(2)
  })
})
