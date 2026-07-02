/**
 * Unit tests for the three Evidence MCP tool handlers:
 *   - addEvidence
 *   - linkEvidence
 *   - listEvidence
 *
 * Prisma is mocked entirely — no real DB connection is used.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Prisma mock setup -------------------------------------------------------
// We mock the entire @/lib/db module so getPrisma() returns a controlled mock.

const mockEvidence = {
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn(),
}

const mockOpportunity = {
  findUnique: vi.fn(),
}

const mockSolution = {
  findUnique: vi.fn(),
}

const mockAssumption = {
  findUnique: vi.fn(),
}

const mockPrisma = {
  evidence: mockEvidence,
  opportunity: mockOpportunity,
  solution: mockSolution,
  assumption: mockAssumption,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// Import handlers AFTER the mock is in place
import { addEvidence, linkEvidence, listEvidence } from "@/lib/evidence-tool-handlers"

// ---------------------------------------------------------------------------

const EVIDENCE_ID = "44444444-4444-4444-4444-444444444444"
const OPP_ID = "22222222-2222-2222-2222-222222222222"
const SOLUTION_ID = "55555555-5555-5555-5555-555555555555"
const ASSUMPTION_ID = "66666666-6666-6666-6666-666666666666"
const WS_ID = "33333333-3333-3333-3333-333333333333"

const sampleOpportunity = { id: OPP_ID, title: "Improve visual accessibility" }
const sampleSolution = { id: SOLUTION_ID, title: "Add dark mode toggle" }
const sampleAssumption = { id: ASSUMPTION_ID, title: "Users want dark mode" }

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// addEvidence
// ---------------------------------------------------------------------------

describe("addEvidence", () => {
  it("creates evidence linked to an opportunity and returns confirmation", async () => {
    mockOpportunity.findUnique.mockResolvedValueOnce(sampleOpportunity)
    mockEvidence.create.mockResolvedValueOnce({ id: EVIDENCE_ID })

    const result = await addEvidence({
      workspaceId: WS_ID,
      sourceType: "interview",
      excerpt: "The user said they'd switch products for dark mode.",
      confidence: "high",
      opportunityId: OPP_ID,
    })
    const text = result.content[0].text

    expect(text).toContain(EVIDENCE_ID)
    expect(text).toContain("opportunity 'Improve visual accessibility'")
    expect(mockEvidence.create).toHaveBeenCalledWith({
      data: {
        workspaceId: WS_ID,
        sourceType: "interview",
        excerpt: "The user said they'd switch products for dark mode.",
        confidence: "high",
        sourceUrl: undefined,
        opportunityId: OPP_ID,
        solutionId: undefined,
        assumptionId: undefined,
      },
    })
  })

  it("defaults confidence to medium when not provided", async () => {
    mockSolution.findUnique.mockResolvedValueOnce(sampleSolution)
    mockEvidence.create.mockResolvedValueOnce({ id: EVIDENCE_ID })

    await addEvidence({
      workspaceId: WS_ID,
      sourceType: "feedback",
      excerpt: "Multiple feedback items requesting this.",
      solutionId: SOLUTION_ID,
    })

    expect(mockEvidence.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ confidence: "medium" }) })
    )
  })

  it("rejects when zero target IDs are provided", async () => {
    const result = await addEvidence({
      workspaceId: WS_ID,
      sourceType: "analytics",
      excerpt: "Some data point.",
    })

    expect(result.content[0].text).toContain("Exactly one of opportunityId, solutionId, or assumptionId")
    expect(mockEvidence.create).not.toHaveBeenCalled()
  })

  it("rejects when more than one target ID is provided", async () => {
    const result = await addEvidence({
      workspaceId: WS_ID,
      sourceType: "analytics",
      excerpt: "Some data point.",
      opportunityId: OPP_ID,
      solutionId: SOLUTION_ID,
    })

    expect(result.content[0].text).toContain("Exactly one of opportunityId, solutionId, or assumptionId")
    expect(mockEvidence.create).not.toHaveBeenCalled()
  })

  it("returns error text when the target node is not found", async () => {
    mockAssumption.findUnique.mockResolvedValueOnce(null)

    const result = await addEvidence({
      workspaceId: WS_ID,
      sourceType: "experiment_result",
      excerpt: "Experiment showed strong signal.",
      assumptionId: ASSUMPTION_ID,
    })

    expect(result.content[0].text).toContain(`"${ASSUMPTION_ID}" not found`)
    expect(mockEvidence.create).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// linkEvidence
// ---------------------------------------------------------------------------

describe("linkEvidence", () => {
  it("re-parents evidence to a new node and clears the others", async () => {
    mockEvidence.findUnique.mockResolvedValueOnce({
      id: EVIDENCE_ID,
      excerpt: "Some evidence excerpt",
      workspaceId: WS_ID,
    })
    mockAssumption.findUnique.mockResolvedValueOnce(sampleAssumption)
    mockEvidence.update.mockResolvedValueOnce({})

    const result = await linkEvidence({ evidenceId: EVIDENCE_ID, assumptionId: ASSUMPTION_ID })
    const text = result.content[0].text

    expect(text).toContain("assumption 'Users want dark mode'")
    expect(mockEvidence.update).toHaveBeenCalledWith({
      where: { id: EVIDENCE_ID },
      data: {
        opportunityId: null,
        solutionId: null,
        assumptionId: ASSUMPTION_ID,
        updatedAt: expect.any(Date),
      },
    })
  })

  it("rejects when zero target IDs are provided", async () => {
    const result = await linkEvidence({ evidenceId: EVIDENCE_ID })

    expect(result.content[0].text).toContain("Exactly one of opportunityId, solutionId, or assumptionId")
    expect(mockEvidence.update).not.toHaveBeenCalled()
  })

  it("rejects when more than one target ID is provided", async () => {
    const result = await linkEvidence({
      evidenceId: EVIDENCE_ID,
      opportunityId: OPP_ID,
      assumptionId: ASSUMPTION_ID,
    })

    expect(result.content[0].text).toContain("Exactly one of opportunityId, solutionId, or assumptionId")
    expect(mockEvidence.update).not.toHaveBeenCalled()
  })

  it("returns error text when evidence is not found", async () => {
    mockEvidence.findUnique.mockResolvedValueOnce(null)

    const result = await linkEvidence({ evidenceId: EVIDENCE_ID, opportunityId: OPP_ID })

    expect(result.content[0].text).toContain(`"${EVIDENCE_ID}" not found`)
    expect(mockOpportunity.findUnique).not.toHaveBeenCalled()
    expect(mockEvidence.update).not.toHaveBeenCalled()
  })

  it("returns error text when the target node is not found", async () => {
    mockEvidence.findUnique.mockResolvedValueOnce({
      id: EVIDENCE_ID,
      excerpt: "Some evidence excerpt",
      workspaceId: WS_ID,
    })
    mockOpportunity.findUnique.mockResolvedValueOnce(null)

    const result = await linkEvidence({ evidenceId: EVIDENCE_ID, opportunityId: OPP_ID })

    expect(result.content[0].text).toContain(`"${OPP_ID}" not found`)
    expect(mockEvidence.update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// listEvidence
// ---------------------------------------------------------------------------

describe("listEvidence", () => {
  const sampleEvidenceRow = {
    id: EVIDENCE_ID,
    sourceType: "interview",
    confidence: "high",
    excerpt: "The user said they'd switch products for dark mode.",
    sourceUrl: "https://example.com/recording",
    createdAt: new Date("2025-01-01T00:00:00Z"),
  }

  it("lists evidence for an opportunity", async () => {
    mockEvidence.findMany.mockResolvedValueOnce([sampleEvidenceRow])

    const result = await listEvidence({ nodeId: OPP_ID, nodeType: "opportunity" })
    const text = result.content[0].text

    expect(text).toContain("interview")
    expect(text).toContain("high confidence")
    expect(text).toContain(EVIDENCE_ID)
    expect(text).toContain("The user said they'd switch products for dark mode.")
    expect(text).toContain("https://example.com/recording")
    expect(mockEvidence.findMany).toHaveBeenCalledWith({
      where: { opportunityId: OPP_ID },
      orderBy: { createdAt: "desc" },
    })
  })

  it("lists evidence for a solution", async () => {
    mockEvidence.findMany.mockResolvedValueOnce([sampleEvidenceRow])

    await listEvidence({ nodeId: SOLUTION_ID, nodeType: "solution" })

    expect(mockEvidence.findMany).toHaveBeenCalledWith({
      where: { solutionId: SOLUTION_ID },
      orderBy: { createdAt: "desc" },
    })
  })

  it("lists evidence for an assumption", async () => {
    mockEvidence.findMany.mockResolvedValueOnce([sampleEvidenceRow])

    await listEvidence({ nodeId: ASSUMPTION_ID, nodeType: "assumption" })

    expect(mockEvidence.findMany).toHaveBeenCalledWith({
      where: { assumptionId: ASSUMPTION_ID },
      orderBy: { createdAt: "desc" },
    })
  })

  it("returns a friendly message when there is no evidence", async () => {
    mockEvidence.findMany.mockResolvedValueOnce([])

    const result = await listEvidence({ nodeId: OPP_ID, nodeType: "opportunity" })

    expect(result.content[0].text).toBe("No evidence found.")
  })
})
