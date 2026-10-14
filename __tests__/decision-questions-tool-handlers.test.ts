import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), tracked: vi.fn(), review: vi.fn(), workspace: vi.fn(), artifacts: vi.fn(),
  taskLink: vi.fn(), agent: vi.fn(), user: vi.fn(),
}))
vi.mock("@/lib/artifacts", () => ({ getDecisionArtifacts: mocks.artifacts }))
vi.mock("@/lib/tracked-decisions", () => ({
  createTrackedDecisionRequest: mocks.create,
  listTrackedDecisions: mocks.list,
  getTrackedDecision: mocks.tracked,
  applyTrackedDecision: vi.fn(),
  recordDecisionNoAction: vi.fn(),
  TrackedDecisionError: class extends Error {},
}))
vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => ({ userId: "user-1", purpose: "USER" }) }))
vi.mock("@/lib/db", () => ({ default: () => ({
  reviewRequest: { findUnique: mocks.review },
  workspace: { findUnique: mocks.workspace },
  taskLink: { findMany: mocks.taskLink },
  agent: { findUnique: mocks.agent },
  user: { findUnique: mocks.user },
}) }))

import { getDecision, getReviewRequest, listDecisions, requestDecision, summarizeDecisionQuestions } from "@/lib/decision-tool-handlers"
import { decisionOptionsInputSchema, decisionQuestionsInputSchema } from "@/lib/decision-option-schema"

const questions = [
  { header: "Timing", question: "When do we ship?", options: [{ label: "Now", description: "This week." }, { label: "Later" }] },
  { question: "Who announces it?", options: [{ label: "PM" }, { label: "Marketing" }] },
]
const submitOptions = [
  { id: "o1", actionKey: "SUBMIT_ANSWERS", label: "Submit answers", description: null, outcomeClass: "APPROVE", sortOrder: 0 },
  { id: "o2", actionKey: "REQUEST_CHANGES", label: "Request changes", description: null, outcomeClass: "REQUEST_CHANGES", sortOrder: 1 },
  { id: "o3", actionKey: "REJECT", label: "Reject", description: null, outcomeClass: "REJECT", sortOrder: 2 },
]
const packetJson = JSON.stringify({ schemaVersion: "tracked-decision/v2", question: "Plan the launch", context: "c", entity: { type: "SOLUTION", id: "s" }, sources: [], questions })
const answersJson = JSON.stringify([{ questionIndex: 0, question: "When do we ship?", chosenOption: "Now" }, { questionIndex: 1, question: "Who announces it?", chosenOption: "PM" }])
const request = (decisions: unknown[] = [], state = "PENDING", packet = packetJson) => ({
  id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", subjectType: "TRACKED_DECISION", subjectId: "key", state,
  requestedById: null, requestedByAgentId: null, noActionAt: null,
  currentRevision: { id: "rev-1", title: "Plan the launch", packetJson: packet, options: submitOptions, decisions },
})
const decided = { id: "d1", optionId: "o1", option: submitOptions[0], rationale: null, answersJson }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.artifacts.mockResolvedValue([])
  mocks.taskLink.mockResolvedValue([])
  mocks.workspace.mockResolvedValue(null)
})

describe("request_decision questions schema", () => {
  const okQuestion = { question: "Q?", options: [{ label: "A" }, { label: "B" }] }

  it("accepts 1-4 questions, each with 2-4 options and an optional header, and is optional", () => {
    expect(decisionQuestionsInputSchema.safeParse(undefined).success).toBe(true)
    expect(decisionQuestionsInputSchema.safeParse([okQuestion]).success).toBe(true)
    expect(decisionQuestionsInputSchema.safeParse(questions).success).toBe(true)
    expect(decisionQuestionsInputSchema.safeParse(Array.from({ length: 4 }, () => okQuestion)).success).toBe(true)
  })

  it.each([
    ["an empty list", []],
    ["five questions", Array.from({ length: 5 }, () => okQuestion)],
    ["an empty question", [{ ...okQuestion, question: "" }]],
    ["a question over 255 characters", [{ ...okQuestion, question: "x".repeat(256) }]],
    ["a header over 40 characters", [{ ...okQuestion, header: "h".repeat(41) }]],
    ["one option", [{ question: "Q", options: [{ label: "A" }] }]],
    ["five options", [{ question: "Q", options: ["A", "B", "C", "D", "E"].map((label) => ({ label })) }]],
    ["a question with no options", [{ question: "Q" }]],
    ["an option label over 120 characters", [{ question: "Q", options: [{ label: "A" }, { label: "x".repeat(121) }] }]],
  ])("rejects %s", (_name, value) => {
    expect(decisionQuestionsInputSchema.safeParse(value).success).toBe(false)
  })

  it("documents itself for the calling agent and keeps the single options schema unchanged", () => {
    const schema = decisionQuestionsInputSchema as unknown as { description?: string }
    expect(schema.description).toMatch(/1-4 questions/)
    expect(schema.description).toMatch(/Mutually exclusive/)
    expect(decisionOptionsInputSchema.safeParse([{ label: "A" }, { label: "B" }]).success).toBe(true)
  })
})

describe("request_decision handler with questions", () => {
  const base = { workspaceId: "ws-1", subjectType: "SOLUTION" as const, subjectId: "solution-1", question: "Plan the launch", context: "Pick.", idempotencyKey: "00000000-0000-4000-8000-000000000001" }

  it("passes questions through to the service and echoes the count", async () => {
    mocks.create.mockResolvedValue({ id: "rev-1", requestId: "request-1" })
    const result = await requestDecision({ ...base, questions })
    expect(result.structuredContent.ok).toBe(true)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ questions, requestedById: "user-1" }))
    expect(result.content[0].text).toContain("Questions: 2")
  })

  it("keeps the question-less response text and service input unchanged", async () => {
    mocks.create.mockResolvedValue({ id: "rev-1", requestId: "request-1" })
    const result = await requestDecision(base)
    expect(result.content[0].text).toBe("Decision requested.\nID: request-1\nRevision ID: rev-1")
    expect(mocks.create.mock.calls[0][0].questions).toBeUndefined()
  })

  it("surfaces the mutual-exclusion error from the service", async () => {
    mocks.create.mockRejectedValue(new Error("Pass either options or questions, not both."))
    const result = await requestDecision({ ...base, questions, options: [{ label: "A" }, { label: "B" }] })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toContain("Pass either options or questions, not both.")
  })
})

describe("decision readers expose questions and answers", () => {
  it("get_decision returns questions with options and, once decided, the answers", async () => {
    mocks.tracked.mockResolvedValue(request([decided], "DECIDED"))
    const result = await getDecision({ workspaceId: "ws-1", requestId: "request-1" })
    const data = result.structuredContent.data as { questions: Array<{ header: string | null; question: string; options: Array<{ label: string; description: string | null }> }>; answers: unknown[] }
    expect(data.questions).toEqual([
      { header: "Timing", question: "When do we ship?", options: [{ label: "Now", description: "This week." }, { label: "Later", description: null }] },
      { header: null, question: "Who announces it?", options: [{ label: "PM", description: null }, { label: "Marketing", description: null }] },
    ])
    expect(data.answers).toEqual([
      { questionIndex: 0, question: "When do we ship?", chosenOption: "Now" },
      { questionIndex: 1, question: "Who announces it?", chosenOption: "PM" },
    ])
    expect(result.content[0].text).toContain("1. [Timing] When do we ship?")
    expect(result.content[0].text).toContain("Answer: Now")
    expect(result.content[0].text).toContain("Answer: PM")
  })

  it("get_decision shows the questions but no answers while pending", async () => {
    mocks.tracked.mockResolvedValue(request())
    const result = await getDecision({ workspaceId: "ws-1", requestId: "request-1" })
    const data = result.structuredContent.data as { questions: unknown[]; answers: unknown[] }
    expect(data.questions).toHaveLength(2)
    expect(data.answers).toEqual([])
    expect(result.content[0].text).not.toContain("Answer:")
  })

  it("get_decision reports no answers when the human requested changes on a multi-question request", async () => {
    const changes = { id: "d2", optionId: "o2", option: submitOptions[1], rationale: "Rework.", answersJson: null }
    mocks.tracked.mockResolvedValue(request([changes], "DECIDED"))
    const result = await getDecision({ workspaceId: "ws-1", requestId: "request-1" })
    const data = result.structuredContent.data as { answers: unknown[]; chosenOption: { outcomeClass: string } }
    expect(data.answers).toEqual([])
    expect(data.chosenOption.outcomeClass).toBe("REQUEST_CHANGES")
  })

  it("get_decision keeps its text unchanged and returns empty arrays for a question-less decision", async () => {
    const plain = { ...request([], "PENDING", JSON.stringify({ schemaVersion: "tracked-decision/v2" })), currentRevision: { id: "rev-1", title: "Which plan?", packetJson: "{}", options: [], decisions: [] } }
    mocks.tracked.mockResolvedValue(plain)
    const result = await getDecision({ workspaceId: "ws-1", requestId: "request-1" })
    expect(result.content[0].text).toBe("Which plan? [PENDING]\nID: request-1")
    const data = result.structuredContent.data as { questions: unknown[]; answers: unknown[] }
    expect(data.questions).toEqual([])
    expect(data.answers).toEqual([])
  })

  it("get_review_request returns questions and answers", async () => {
    mocks.review.mockResolvedValue(request([decided], "DECIDED"))
    const result = await getReviewRequest({ requestId: "request-1" })
    const data = result.structuredContent.data as { questions: unknown[]; answers: Array<{ chosenOption: string }> }
    expect(data.questions).toHaveLength(2)
    expect(data.answers.map((answer) => answer.chosenOption)).toEqual(["Now", "PM"])
  })

  it("list_decisions includes questions and answers per row and answers in the summary line", async () => {
    mocks.list.mockResolvedValue({ requests: [request([decided], "DECIDED"), request()], total: 2, page: 1, pageSize: 20, pageCount: 1 })
    const result = await listDecisions({ workspaceId: "ws-1" })
    const rows = (result.structuredContent.data as { requests: Array<{ questions: unknown[]; answers: unknown[] }> }).requests
    expect(rows[0].questions).toHaveLength(2)
    expect(rows[0].answers).toHaveLength(2)
    expect(rows[1].answers).toEqual([])
    expect(result.content[0].text).toContain("Plan the launch [DECIDED] → Now / PM (request-1)")
    expect(result.content[0].text).toContain("Plan the launch [PENDING] (request-1)")
  })

  it("summarizeDecisionQuestions tolerates a missing revision, an unreadable packet, and unreadable answers", () => {
    expect(summarizeDecisionQuestions(null)).toEqual({ questions: [], answers: [] })
    expect(summarizeDecisionQuestions({ packetJson: "not json", decisions: [{ answersJson: "{" }] })).toEqual({ questions: [], answers: [] })
  })
})
