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

import { getDecision, getReviewRequest, listDecisions, requestDecision, summarizeDecisionOptions } from "@/lib/decision-tool-handlers"
import { decisionOptionsInputSchema } from "@/lib/decision-option-schema"

const choiceOptions = [
  { id: "o1", actionKey: "CHOICE_1", label: "Ship now", description: "Release this week.", outcomeClass: "APPROVE", sortOrder: 0 },
  { id: "o2", actionKey: "CHOICE_2", label: "Wait a sprint", description: null, outcomeClass: "APPROVE", sortOrder: 1 },
  { id: "o3", actionKey: "REQUEST_CHANGES", label: "Request changes", description: null, outcomeClass: "REQUEST_CHANGES", sortOrder: 2 },
  { id: "o4", actionKey: "REJECT", label: "Reject", description: null, outcomeClass: "REJECT", sortOrder: 3 },
]
const standardOptions = [
  { id: "a", actionKey: "APPROVE", label: "Approve", description: null, outcomeClass: "APPROVE", sortOrder: 0 },
  { id: "c", actionKey: "REQUEST_CHANGES", label: "Request changes", description: null, outcomeClass: "REQUEST_CHANGES", sortOrder: 1 },
  { id: "r", actionKey: "REJECT", label: "Reject", description: null, outcomeClass: "REJECT", sortOrder: 2 },
]
const request = (options: typeof choiceOptions, decisions: unknown[] = [], state = "PENDING") => ({
  id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", subjectType: "TRACKED_DECISION", subjectId: "key", state,
  requestedById: null, requestedByAgentId: null, noActionAt: null,
  currentRevision: { id: "rev-1", title: "Which plan?", options, decisions },
})

beforeEach(() => {
  vi.resetAllMocks()
  mocks.artifacts.mockResolvedValue([])
  mocks.taskLink.mockResolvedValue([])
  mocks.workspace.mockResolvedValue(null)
})

describe("request_decision options schema", () => {
  it("accepts 2-4 options with optional descriptions and treats the field as optional", () => {
    expect(decisionOptionsInputSchema.safeParse(undefined).success).toBe(true)
    expect(decisionOptionsInputSchema.safeParse([{ label: "A" }, { label: "B", description: "Because." }]).success).toBe(true)
    expect(decisionOptionsInputSchema.safeParse(["A", "B", "C", "D"].map((label) => ({ label }))).success).toBe(true)
  })

  it.each([
    ["one option", [{ label: "A" }]],
    ["an empty list", []],
    ["five options", ["A", "B", "C", "D", "E"].map((label) => ({ label }))],
    ["an empty label", [{ label: "A" }, { label: "" }]],
    ["a label over 120 characters", [{ label: "A" }, { label: "x".repeat(121) }]],
    ["a description over 500 characters", [{ label: "A" }, { label: "B", description: "x".repeat(501) }]],
  ])("rejects %s", (_name, value) => {
    expect(decisionOptionsInputSchema.safeParse(value).success).toBe(false)
  })

  it("documents label and description for the calling agent", () => {
    const schema = decisionOptionsInputSchema as unknown as { description?: string }
    expect(schema.description).toMatch(/2-4/)
    expect(JSON.stringify(decisionOptionsInputSchema.toJSONSchema?.() ?? {})).toMatch(/Short choice label/)
  })
})

describe("request_decision handler", () => {
  const base = { workspaceId: "ws-1", subjectType: "SOLUTION" as const, subjectId: "solution-1", question: "Which plan?", context: "Pick.", idempotencyKey: "00000000-0000-4000-8000-000000000001" }

  it("passes options through to the service and echoes them", async () => {
    mocks.create.mockResolvedValue({ id: "rev-1", requestId: "request-1" })
    const options = [{ label: "Ship now", description: "Soon" }, { label: "Wait" }]
    const result = await requestDecision({ ...base, options })
    expect(result.structuredContent.ok).toBe(true)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ options, requestedById: "user-1" }))
    expect(result.content[0].text).toContain("Options: Ship now | Wait")
  })

  it("keeps the option-less response text unchanged", async () => {
    mocks.create.mockResolvedValue({ id: "rev-1", requestId: "request-1" })
    const result = await requestDecision(base)
    expect(result.content[0].text).toBe("Decision requested.\nID: request-1\nRevision ID: rev-1")
    expect(mocks.create.mock.calls[0][0].options).toBeUndefined()
  })

  it("surfaces validation failures from the service as an error result", async () => {
    mocks.create.mockRejectedValue(new Error("Option labels must be unique."))
    const result = await requestDecision({ ...base, options: [{ label: "A" }, { label: "a" }] })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toContain("Option labels must be unique.")
  })
})

describe("decision readers expose options and the chosen option", () => {
  const chosenDecision = { id: "d1", optionId: "o1", option: choiceOptions[0], rationale: "Ready." }

  it("get_decision lists options and reports the chosen one once decided", async () => {
    mocks.tracked.mockResolvedValue(request(choiceOptions, [chosenDecision], "DECIDED"))
    const result = await getDecision({ workspaceId: "ws-1", requestId: "request-1" })
    const data = result.structuredContent.data as { options: Array<{ label: string; description: string | null; outcomeClass: string }>; chosenOption: { label: string; description: string | null; outcomeClass: string } | null }
    expect(data.options.map((option) => [option.label, option.description, option.outcomeClass])).toEqual([
      ["Ship now", "Release this week.", "APPROVE"], ["Wait a sprint", null, "APPROVE"], ["Request changes", null, "REQUEST_CHANGES"], ["Reject", null, "REJECT"],
    ])
    expect(data.chosenOption).toEqual(expect.objectContaining({ label: "Ship now", description: "Release this week.", outcomeClass: "APPROVE" }))
    expect(result.content[0].text).toContain("Options:\n  • Ship now — Release this week.\n  • Wait a sprint")
    expect(result.content[0].text).toContain("Chosen: Ship now (APPROVE)")
  })

  it("get_decision shows options but no chosen option while pending", async () => {
    mocks.tracked.mockResolvedValue(request(choiceOptions))
    const result = await getDecision({ workspaceId: "ws-1", requestId: "request-1" })
    expect((result.structuredContent.data as { chosenOption: unknown }).chosenOption).toBeNull()
    expect(result.content[0].text).not.toContain("Chosen:")
  })

  it("get_decision text is unchanged for an option-less decision, with the standard options still structured", async () => {
    mocks.tracked.mockResolvedValue(request(standardOptions, [{ id: "d", optionId: "a", option: standardOptions[0] }], "DECIDED"))
    const result = await getDecision({ workspaceId: "ws-1", requestId: "request-1" })
    expect(result.content[0].text).toBe("Which plan? [DECIDED]\nID: request-1")
    expect((result.structuredContent.data as { chosenOption: { label: string } }).chosenOption.label).toBe("Approve")
  })

  it("get_review_request resolves the chosen option from the bare decision record", async () => {
    mocks.review.mockResolvedValue(request(choiceOptions, [{ id: "d1", optionId: "o2", rationale: null }], "DECIDED"))
    const result = await getReviewRequest({ requestId: "request-1" })
    const data = result.structuredContent.data as { chosenOption: { label: string }; options: unknown[] }
    expect(data.chosenOption.label).toBe("Wait a sprint")
    expect(data.options).toHaveLength(4)
    expect(result.content[0].text).toContain("Chosen: Wait a sprint (APPROVE)")
  })

  it("list_decisions includes options and the chosen option per row", async () => {
    mocks.list.mockResolvedValue({ requests: [request(choiceOptions, [chosenDecision], "DECIDED"), request(standardOptions)], total: 2, page: 1, pageSize: 20, pageCount: 1 })
    const result = await listDecisions({ workspaceId: "ws-1" })
    const rows = (result.structuredContent.data as { requests: Array<{ options: unknown[]; chosenOption: { label: string } | null }> }).requests
    expect(rows[0].options).toHaveLength(4)
    expect(rows[0].chosenOption?.label).toBe("Ship now")
    expect(rows[1].chosenOption).toBeNull()
    expect(result.content[0].text).toContain("Which plan? [DECIDED] → Ship now (request-1)")
    expect(result.content[0].text).toContain("Which plan? [PENDING] (request-1)")
  })

  it("summarizeDecisionOptions tolerates a missing revision", () => {
    expect(summarizeDecisionOptions(null)).toEqual({ options: [], chosenOption: null, hasChoices: false })
  })
})
