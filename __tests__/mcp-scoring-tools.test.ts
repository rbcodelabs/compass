/**
 * Unit tests for the 10 Scoring MCP tool handlers.
 * Prisma is mocked entirely — no real DB connection is used.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

const mockOrganization = { findUnique: vi.fn() }
const mockScoringModel = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}
const mockScoringModelMetric = {
  createMany: vi.fn(),
  deleteMany: vi.fn(),
}
const mockWorkspace = { findUnique: vi.fn() }
const mockWorkspaceScoringConfig = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
}
const mockOpportunity = { findUnique: vi.fn() }
const mockOpportunityScore = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
}

const mockPrisma = {
  organization: mockOrganization,
  scoringModel: mockScoringModel,
  scoringModelMetric: mockScoringModelMetric,
  workspace: mockWorkspace,
  workspaceScoringConfig: mockWorkspaceScoringConfig,
  opportunity: mockOpportunity,
  opportunityScore: mockOpportunityScore,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

import {
  listScoringModels,
  getScoringModel,
  createScoringModel,
  updateScoringModel,
  archiveScoringModel,
  getWorkspaceScoringModel,
  setWorkspaceScoringModel,
  scoreOpportunity,
  getOpportunityScore,
  listTopOpportunities,
} from "@/lib/scoring-tool-handlers"

const ORG_ID = "aaaaaaaa-0000-0000-0000-000000000001"
const MODEL_ID = "bbbbbbbb-0000-0000-0000-000000000002"
const WS_ID = "cccccccc-0000-0000-0000-000000000003"
const OPP_ID = "dddddddd-0000-0000-0000-000000000004"

const weightedSumMetrics = [
  { id: "m1", key: "reach", label: "Reach", description: null, minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE", order: 0 },
  { id: "m2", key: "effort", label: "Effort", description: null, minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE", order: 1 },
]

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── listScoringModels ────────────────────────────────────────────────────

describe("listScoringModels", () => {
  it("lists models with status, version, formula type and metric count", async () => {
    mockOrganization.findUnique.mockResolvedValueOnce({ id: ORG_ID })
    mockScoringModel.findMany.mockResolvedValueOnce([
      { id: MODEL_ID, name: "RICE", description: "Classic RICE", status: "ACTIVE", formulaType: "WEIGHTED_SUM", version: 1, metrics: weightedSumMetrics },
    ])

    const result = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => listScoringModels({ orgSlug: "acme" }))
    const text = result.content[0].text

    expect(text).toContain("RICE")
    expect(text).toContain("[ACTIVE]")
    expect(text).toContain("v1")
    expect(text).toContain("WEIGHTED_SUM")
    expect(text).toContain("2 metric(s)")
    expect(text).toContain(`ID: ${MODEL_ID}`)
  })

  it("returns a not-found message when the org doesn't exist", async () => {
    mockOrganization.findUnique.mockResolvedValueOnce(null)
    const result = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => listScoringModels({ orgSlug: "missing" }))
    expect(result.content[0].text).toContain('"missing" not found')
    expect(mockScoringModel.findMany).not.toHaveBeenCalled()
  })

  it("returns an empty message when the org has no models", async () => {
    mockOrganization.findUnique.mockResolvedValueOnce({ id: ORG_ID })
    mockScoringModel.findMany.mockResolvedValueOnce([])
    const result = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => listScoringModels({ orgSlug: "acme" }))
    expect(result.content[0].text).toContain("No scoring models")
  })
})

// ─── getScoringModel ──────────────────────────────────────────────────────

describe("getScoringModel", () => {
  it("returns full detail including all metrics", async () => {
    mockScoringModel.findUnique.mockResolvedValueOnce({
      id: MODEL_ID, name: "RICE", description: "Classic RICE", status: "ACTIVE",
      formulaType: "WEIGHTED_SUM", version: 1, metrics: weightedSumMetrics,
    })

    const result = await getScoringModel({ scoringModelId: MODEL_ID })
    const text = result.content[0].text

    expect(text).toContain("## RICE")
    expect(text).toContain(`ID: ${MODEL_ID}`)
    expect(text).toContain("Reach (reach) [POSITIVE]")
    expect(text).toContain("Effort (effort) [NEGATIVE]")
  })

  it("returns error text when not found", async () => {
    mockScoringModel.findUnique.mockResolvedValueOnce(null)
    const result = await getScoringModel({ scoringModelId: MODEL_ID })
    expect(result.content[0].text).toContain(`"${MODEL_ID}" not found`)
  })
})

// ─── createScoringModel ───────────────────────────────────────────────────

describe("createScoringModel", () => {
  it("creates the model and its metrics", async () => {
    mockOrganization.findUnique.mockResolvedValueOnce({ id: ORG_ID })
    mockScoringModel.create.mockResolvedValueOnce({ id: MODEL_ID })
    mockScoringModelMetric.createMany.mockResolvedValueOnce({ count: 2 })

    const result = await createScoringModel({
      orgSlug: "acme",
      name: "RICE",
      formulaType: "WEIGHTED_SUM",
      metrics: [
        { key: "reach", label: "Reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
        { key: "effort", label: "Effort", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE" },
      ],
    })

    expect(mockScoringModel.create).toHaveBeenCalledWith({
      data: { organizationId: ORG_ID, name: "RICE", description: undefined, formulaType: "WEIGHTED_SUM" },
    })
    expect(mockScoringModelMetric.createMany).toHaveBeenCalledOnce()
    expect(result.content[0].text).toContain(`ID: ${MODEL_ID}`)
  })

  it("rejects MULTIPLICATIVE models with a metric minValue <= 0 without creating", async () => {
    mockOrganization.findUnique.mockResolvedValueOnce({ id: ORG_ID })

    const result = await createScoringModel({
      orgSlug: "acme",
      name: "True RICE",
      formulaType: "MULTIPLICATIVE",
      metrics: [{ key: "reach", label: "Reach", minValue: 0, maxValue: 1000, weight: 1, direction: "POSITIVE" }],
    })

    expect(result.content[0].text).toContain("minValue greater than 0")
    expect(mockScoringModel.create).not.toHaveBeenCalled()
  })

  it("returns error text when the org doesn't exist", async () => {
    mockOrganization.findUnique.mockResolvedValueOnce(null)
    const result = await createScoringModel({ orgSlug: "missing", name: "RICE", formulaType: "WEIGHTED_SUM", metrics: [] })
    expect(result.content[0].text).toContain('"missing" not found')
    expect(mockScoringModel.create).not.toHaveBeenCalled()
  })
})

// ─── updateScoringModel ───────────────────────────────────────────────────

describe("updateScoringModel", () => {
  it("updates name/description only without bumping version", async () => {
    mockScoringModel.findUnique.mockResolvedValueOnce({ id: MODEL_ID, formulaType: "WEIGHTED_SUM", version: 1 })

    const result = await updateScoringModel({ scoringModelId: MODEL_ID, name: "New name" })

    const data = mockScoringModel.update.mock.calls[0][0].data
    expect(data.name).toBe("New name")
    expect(data.version).toBeUndefined()
    expect(mockScoringModelMetric.deleteMany).not.toHaveBeenCalled()
    expect(result.content[0].text).not.toContain("Version bumped")
  })

  it("replaces metrics and bumps version", async () => {
    mockScoringModel.findUnique.mockResolvedValueOnce({ id: MODEL_ID, formulaType: "WEIGHTED_SUM", version: 1 })

    const result = await updateScoringModel({
      scoringModelId: MODEL_ID,
      metrics: [{ key: "reach", label: "Reach", minValue: 0, maxValue: 10, weight: 2, direction: "POSITIVE" }],
    })

    expect(mockScoringModelMetric.deleteMany).toHaveBeenCalledWith({ where: { scoringModelId: MODEL_ID } })
    expect(mockScoringModelMetric.createMany).toHaveBeenCalledOnce()
    const data = mockScoringModel.update.mock.calls[0][0].data
    expect(data.version).toBe(2)
    expect(result.content[0].text).toContain("Version bumped to 2")
  })

  it("rejects switching to MULTIPLICATIVE if a metric has minValue <= 0", async () => {
    mockScoringModel.findUnique.mockResolvedValueOnce({ id: MODEL_ID, formulaType: "WEIGHTED_SUM", version: 1 })

    const result = await updateScoringModel({
      scoringModelId: MODEL_ID,
      formulaType: "MULTIPLICATIVE",
      metrics: [{ key: "reach", label: "Reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" }],
    })

    expect(result.content[0].text).toContain("minValue greater than 0")
    expect(mockScoringModelMetric.deleteMany).not.toHaveBeenCalled()
  })

  it("returns error text when not found", async () => {
    mockScoringModel.findUnique.mockResolvedValueOnce(null)
    const result = await updateScoringModel({ scoringModelId: MODEL_ID, name: "X" })
    expect(result.content[0].text).toContain(`"${MODEL_ID}" not found`)
  })
})

// ─── archiveScoringModel ──────────────────────────────────────────────────

describe("archiveScoringModel", () => {
  it("archives and returns confirmation with an ID line", async () => {
    mockScoringModel.findUnique.mockResolvedValueOnce({ id: MODEL_ID, name: "RICE" })

    const result = await archiveScoringModel({ scoringModelId: MODEL_ID })

    expect(mockScoringModel.update).toHaveBeenCalledWith({
      where: { id: MODEL_ID },
      data: { status: "ARCHIVED", updatedAt: expect.any(Date) },
    })
    expect(result.content[0].text).toContain("archived")
    expect(result.content[0].text).toContain(`ID: ${MODEL_ID}`)
  })

  it("returns error text when not found", async () => {
    mockScoringModel.findUnique.mockResolvedValueOnce(null)
    const result = await archiveScoringModel({ scoringModelId: MODEL_ID })
    expect(result.content[0].text).toContain(`"${MODEL_ID}" not found`)
    expect(mockScoringModel.update).not.toHaveBeenCalled()
  })
})

// ─── getWorkspaceScoringModel ─────────────────────────────────────────────

describe("getWorkspaceScoringModel", () => {
  it("returns the active model and its metrics", async () => {
    mockWorkspaceScoringConfig.findUnique.mockResolvedValueOnce({
      scoringModelId: MODEL_ID,
      scoringModel: { id: MODEL_ID, name: "RICE", formulaType: "WEIGHTED_SUM", version: 1, metrics: weightedSumMetrics },
    })

    const result = await getWorkspaceScoringModel({ workspaceId: WS_ID })
    const text = result.content[0].text

    expect(text).toContain("RICE")
    expect(text).toContain(`ID: ${MODEL_ID}`)
  })

  it("returns a no-active-model message when unset", async () => {
    mockWorkspaceScoringConfig.findUnique.mockResolvedValueOnce(null)
    const result = await getWorkspaceScoringModel({ workspaceId: WS_ID })
    expect(result.content[0].text).toContain("no active scoring model")
  })
})

// ─── setWorkspaceScoringModel ─────────────────────────────────────────────

describe("setWorkspaceScoringModel", () => {
  it("sets the active model", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce({ id: WS_ID })
    mockScoringModel.findUnique.mockResolvedValueOnce({ id: MODEL_ID })

    const result = await setWorkspaceScoringModel({ workspaceId: WS_ID, scoringModelId: MODEL_ID })

    expect(mockWorkspaceScoringConfig.upsert).toHaveBeenCalledWith({
      where: { workspaceId: WS_ID },
      create: { workspaceId: WS_ID, scoringModelId: MODEL_ID },
      update: { scoringModelId: MODEL_ID, updatedAt: expect.any(Date) },
    })
    expect(result.content[0].text).toContain("set")
  })

  it("clears the active model when scoringModelId is null", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce({ id: WS_ID })

    const result = await setWorkspaceScoringModel({ workspaceId: WS_ID, scoringModelId: null })

    expect(mockScoringModel.findUnique).not.toHaveBeenCalled()
    expect(mockWorkspaceScoringConfig.upsert).toHaveBeenCalledWith({
      where: { workspaceId: WS_ID },
      create: { workspaceId: WS_ID, scoringModelId: null },
      update: { scoringModelId: null, updatedAt: expect.any(Date) },
    })
    expect(result.content[0].text).toContain("cleared")
  })

  it("returns error text when workspace not found", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(null)
    const result = await setWorkspaceScoringModel({ workspaceId: WS_ID, scoringModelId: MODEL_ID })
    expect(result.content[0].text).toContain(`"${WS_ID}" not found`)
    expect(mockWorkspaceScoringConfig.upsert).not.toHaveBeenCalled()
  })

  it("returns error text when scoring model not found", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce({ id: WS_ID })
    mockScoringModel.findUnique.mockResolvedValueOnce(null)
    const result = await setWorkspaceScoringModel({ workspaceId: WS_ID, scoringModelId: MODEL_ID })
    expect(result.content[0].text).toContain(`"${MODEL_ID}" not found`)
    expect(mockWorkspaceScoringConfig.upsert).not.toHaveBeenCalled()
  })
})

// ─── scoreOpportunity ─────────────────────────────────────────────────────

describe("scoreOpportunity", () => {
  beforeEach(() => {
    mockOpportunity.findUnique.mockResolvedValue({ id: OPP_ID, title: "Improve onboarding", workspaceId: WS_ID })
    mockWorkspaceScoringConfig.findUnique.mockResolvedValue({
      scoringModelId: MODEL_ID,
      scoringModel: { id: MODEL_ID, formulaType: "WEIGHTED_SUM", version: 3, metrics: weightedSumMetrics },
    })
    mockOpportunityScore.upsert.mockResolvedValue({ id: "score-1" })
  })

  it("computes and upserts a score, returning raw and normalized values", async () => {
    const result = await scoreOpportunity({ opportunityId: OPP_ID, rawValues: { reach: 8, effort: 2 } })

    expect(mockOpportunityScore.upsert).toHaveBeenCalledWith({
      where: { opportunityId: OPP_ID },
      create: expect.objectContaining({ opportunityId: OPP_ID, scoringModelId: MODEL_ID, modelVersion: 3, rawScore: 6 }),
      update: expect.objectContaining({ scoringModelId: MODEL_ID, modelVersion: 3, rawScore: 6, updatedAt: expect.any(Date) }),
    })
    expect(result.content[0].text).toContain("Improve onboarding")
    expect(result.content[0].text).toContain("ID: score-1")
  })

  it("returns error text when opportunity not found", async () => {
    mockOpportunity.findUnique.mockResolvedValueOnce(null)
    const result = await scoreOpportunity({ opportunityId: OPP_ID, rawValues: {} })
    expect(result.content[0].text).toContain(`"${OPP_ID}" not found`)
    expect(mockOpportunityScore.upsert).not.toHaveBeenCalled()
  })

  it("returns error text when workspace has no active scoring model", async () => {
    mockWorkspaceScoringConfig.findUnique.mockResolvedValueOnce(null)
    const result = await scoreOpportunity({ opportunityId: OPP_ID, rawValues: { reach: 8, effort: 2 } })
    expect(result.content[0].text).toContain("no active scoring model")
    expect(mockOpportunityScore.upsert).not.toHaveBeenCalled()
  })

  it("returns error text when a metric value is missing", async () => {
    const result = await scoreOpportunity({ opportunityId: OPP_ID, rawValues: { reach: 8 } })
    expect(result.content[0].text).toContain('Missing value for metric "effort"')
    expect(mockOpportunityScore.upsert).not.toHaveBeenCalled()
  })

  it("returns error text when a value is out of bounds", async () => {
    const result = await scoreOpportunity({ opportunityId: OPP_ID, rawValues: { reach: 500, effort: 2 } })
    expect(result.content[0].text).toContain('"reach" must be between 0 and 10')
    expect(mockOpportunityScore.upsert).not.toHaveBeenCalled()
  })
})

// ─── getOpportunityScore ──────────────────────────────────────────────────

describe("getOpportunityScore", () => {
  it("returns score detail with stale=false when versions match", async () => {
    mockOpportunityScore.findUnique.mockResolvedValueOnce({
      id: "score-1", modelVersion: 2, rawScore: 6, normalizedScore: 75,
      scoredAt: new Date("2026-01-01T00:00:00Z"),
      scoringModel: { name: "RICE", version: 2 },
    })

    const result = await getOpportunityScore({ opportunityId: OPP_ID })
    const text = result.content[0].text

    expect(text).toContain("Stale: false")
    expect(text).toContain("ID: score-1")
  })

  it("returns stale=true when the live model version has moved ahead", async () => {
    mockOpportunityScore.findUnique.mockResolvedValueOnce({
      id: "score-1", modelVersion: 1, rawScore: 6, normalizedScore: 75,
      scoredAt: new Date("2026-01-01T00:00:00Z"),
      scoringModel: { name: "RICE", version: 2 },
    })

    const result = await getOpportunityScore({ opportunityId: OPP_ID })
    expect(result.content[0].text).toContain("Stale: true")
  })

  it("returns error text when no score exists", async () => {
    mockOpportunityScore.findUnique.mockResolvedValueOnce(null)
    const result = await getOpportunityScore({ opportunityId: OPP_ID })
    expect(result.content[0].text).toContain(`No score found for opportunity "${OPP_ID}"`)
  })
})

// ─── listTopOpportunities ─────────────────────────────────────────────────

describe("listTopOpportunities", () => {
  it("lists scores sorted desc by normalizedScore for a single workspace", async () => {
    mockOpportunityScore.findMany.mockResolvedValueOnce([
      { normalizedScore: 90, opportunity: { id: "opp-a", title: "A", status: "PRIORITIZED", workspace: { name: "WS" } } },
      { normalizedScore: 50, opportunity: { id: "opp-b", title: "B", status: "EXPLORING", workspace: { name: "WS" } } },
    ])

    const result = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => listTopOpportunities({ workspaceId: WS_ID }))
    const text = result.content[0].text

    expect(mockOpportunityScore.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { opportunity: { workspaceId: WS_ID } },
        orderBy: { normalizedScore: "desc" },
      })
    )
    expect(text.indexOf("A")).toBeLessThan(text.indexOf("B"))
    expect(text).not.toContain("(WS)") // single-workspace view omits the workspace name
  })

  it("shows the workspace name for a cross-workspace orgSlug view", async () => {
    mockOpportunityScore.findMany.mockResolvedValueOnce([
      { normalizedScore: 90, opportunity: { id: "opp-a", title: "A", status: "PRIORITIZED", workspace: { name: "Team Alpha" } } },
    ])

    const result = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => listTopOpportunities({ orgSlug: "acme" }))

    expect(mockOpportunityScore.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { opportunity: { workspace: { organization: { slug: "acme" } } } },
      })
    )
    expect(result.content[0].text).toContain("(Team Alpha)")
  })

  it("returns an error message when neither workspaceId nor orgSlug is provided", async () => {
    const result = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => listTopOpportunities({}))
    expect(result.content[0].text).toContain("Provide either workspaceId or orgSlug")
    expect(mockOpportunityScore.findMany).not.toHaveBeenCalled()
  })

  it("returns an empty message when there are no scored opportunities", async () => {
    mockOpportunityScore.findMany.mockResolvedValueOnce([])
    const result = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => listTopOpportunities({ workspaceId: WS_ID }))
    expect(result.content[0].text).toContain("No scored opportunities found")
  })
})
