/**
 * Deeplink coverage for the create/promote MCP tools registered directly in
 * app/api/mcp/route.ts.
 *
 * Every one of these used to return a bare `ID: <uuid>` with nothing a human
 * could click. They now append a `URL:` line built from the shared
 * lib/entity-links.ts path builder. Two properties matter and are asserted
 * per tool:
 *   1. the URL points at the entity's canonical surface (own page, or the
 *      `?detail=<type>:<id>` panel), and
 *   2. a workspace whose slugs can't be resolved degrades to *no* URL line
 *      while the underlying create still succeeds — a link is never fabricated
 *      and never breaks the mutation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

const mockPrisma = {
  workspace: { findUnique: vi.fn() },
  opportunity: { findUnique: vi.fn(), create: vi.fn() },
  solution: { findUnique: vi.fn(), create: vi.fn() },
  assumption: { findUnique: vi.fn(), create: vi.fn() },
  objective: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  keyResult: { create: vi.fn() },
  oKRCycle: { findFirst: vi.fn() },
  experiment: { create: vi.fn() },
  roadmapItem: { findFirst: vi.fn(), create: vi.fn() },
  portfolioCapacityReservation: { findUnique: vi.fn() },
  portfolioCapacityPlan: { updateMany: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

type ToolCallback = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
const registeredTools: Record<string, ToolCallback> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: unknown, cb: ToolCallback) => void }) => void) => {
    setup({ registerTool(name, _meta, cb) { registeredTools[name] = cb } })
    return () => new Response("ok")
  },
}))

vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }))

await import("@/app/api/mcp/route")

function call(name: string, args: Record<string, unknown>) {
  const handler = registeredTools[name]
  if (!handler) throw new Error(`Tool "${name}" was not registered`)
  return runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => handler(args)) as Promise<{ content: Array<{ text: string }> }>
}

const ENV_KEYS = ["VERCEL_ENV", "VERCEL_BRANCH_URL", "VERCEL_URL", "NEXT_PUBLIC_APP_URL"] as const
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

/** A workspace row carrying the slugs a link needs. */
const SLUGGED = { name: "Compass", slug: "compass", organization: { slug: "rbcodelabs" } }
/** The same row as it looked before this change: name only, no slugs. */
const UNSLUGGED = { name: "Compass" }

const BASE = "http://localhost:3000/rbcodelabs/compass"

beforeEach(() => {
  vi.clearAllMocks()
  ENV_KEYS.forEach((key) => delete process.env[key])
  mockPrisma.roadmapItem.findFirst.mockResolvedValue(null)
  mockPrisma.portfolioCapacityReservation.findUnique.mockResolvedValue(null)
  mockPrisma.$transaction.mockImplementation((operation: Promise<unknown>[] | ((db: typeof mockPrisma) => unknown)) =>
    Array.isArray(operation) ? Promise.all(operation) : operation(mockPrisma))
})

afterEach(() => ENV_KEYS.forEach((key) => {
  const value = originalEnv[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}))

describe("create_opportunity deeplink", () => {
  const args = { workspaceId: "ws-1", title: "Setup is confusing" }

  beforeEach(() => {
    mockPrisma.opportunity.create.mockResolvedValue({ id: "opp-1", title: "Setup is confusing", status: "EXPLORING" })
  })

  it("links to the opportunity's own discovery page", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(SLUGGED)
    const text = (await call("create_opportunity", args)).content[0].text
    expect(text).toContain("ID: opp-1")
    expect(text).toContain(`URL: ${BASE}/discovery/opp-1`)
  })

  it("still creates the opportunity, without a URL line, when slugs are unavailable", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(UNSLUGGED)
    const text = (await call("create_opportunity", args)).content[0].text
    expect(mockPrisma.opportunity.create).toHaveBeenCalled()
    expect(text).toContain("ID: opp-1")
    expect(text).not.toContain("URL:")
  })

  it("still creates the opportunity, without a URL line, when the origin is unconfigured", async () => {
    process.env.VERCEL_ENV = "production"
    mockPrisma.workspace.findUnique.mockResolvedValue(SLUGGED)
    const text = (await call("create_opportunity", args)).content[0].text
    expect(mockPrisma.opportunity.create).toHaveBeenCalled()
    expect(text).toContain("ID: opp-1")
    expect(text).not.toContain("URL:")
  })
})

describe("add_solution deeplink", () => {
  it("opens the solution panel on its owning opportunity page", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue({
      id: "opp-1", title: "Setup is confusing", workspace: SLUGGED,
    })
    mockPrisma.solution.create.mockResolvedValue({ id: "sol-1", title: "Guided setup", status: "IDEA" })
    const text = (await call("add_solution", { opportunityId: "opp-1", title: "Guided setup" })).content[0].text
    expect(text).toContain(`URL: ${BASE}/discovery/opp-1?detail=solution%3Asol-1`)
  })

  it("omits the URL line when the opportunity carries no workspace slugs", async () => {
    mockPrisma.opportunity.findUnique.mockResolvedValue({ id: "opp-1", title: "Setup is confusing" })
    mockPrisma.solution.create.mockResolvedValue({ id: "sol-1", title: "Guided setup", status: "IDEA" })
    const text = (await call("add_solution", { opportunityId: "opp-1", title: "Guided setup" })).content[0].text
    expect(text).toContain("ID: sol-1")
    expect(text).not.toContain("URL:")
  })
})

describe("add_assumption deeplink", () => {
  it("opens the assumption panel on the owning opportunity page (two-hop scope)", async () => {
    mockPrisma.solution.findUnique.mockResolvedValue({
      id: "sol-1", title: "Guided setup",
      opportunity: { id: "opp-1", workspace: SLUGGED },
    })
    mockPrisma.assumption.create.mockResolvedValue({ id: "asm-1", title: "Users will finish", riskLevel: "HIGH", status: "UNTESTED", description: null })
    const text = (await call("add_assumption", { solutionId: "sol-1", title: "Users will finish", riskLevel: "HIGH" })).content[0].text
    expect(text).toContain(`URL: ${BASE}/discovery/opp-1?detail=assumption%3Aasm-1`)
  })

  it("omits the URL line when the parent chain carries no slugs", async () => {
    mockPrisma.solution.findUnique.mockResolvedValue({ id: "sol-1", title: "Guided setup" })
    mockPrisma.assumption.create.mockResolvedValue({ id: "asm-1", title: "Users will finish", riskLevel: "HIGH", status: "UNTESTED", description: null })
    const text = (await call("add_assumption", { solutionId: "sol-1", title: "Users will finish", riskLevel: "HIGH" })).content[0].text
    expect(text).toContain("ID: asm-1")
    expect(text).not.toContain("URL:")
  })
})

describe("create_objective deeplink", () => {
  it("opens the objective panel on the OKRs page", async () => {
    mockPrisma.oKRCycle.findFirst.mockResolvedValue({ id: "cycle-1", title: "Q3", workspace: SLUGGED })
    mockPrisma.objective.create.mockResolvedValue({ id: "obj-1", title: "Grow activation", status: "ON_TRACK", description: null, owner: null, squadId: null, parentKeyResultId: null })
    const text = (await call("create_objective", { workspaceId: "ws-1", cycleId: "cycle-1", title: "Grow activation" })).content[0].text
    expect(text).toContain(`URL: ${BASE}/okrs?detail=objective%3Aobj-1`)
  })
})

describe("add_key_result deeplink", () => {
  it("opens the key result panel on the OKRs page (scoped through objective -> cycle)", async () => {
    mockPrisma.objective.findUnique.mockResolvedValue({
      id: "obj-1", title: "Grow activation", cycle: { workspace: SLUGGED },
    })
    mockPrisma.keyResult.create.mockResolvedValue({ id: "kr-1", title: "Activation rate", target: 50, unit: "%", current: 0 })
    const text = (await call("add_key_result", { objectiveId: "obj-1", title: "Activation rate", target: 50 })).content[0].text
    expect(text).toContain(`URL: ${BASE}/okrs?detail=keyResult%3Akr-1`)
  })

  it("omits the URL line when the cycle's workspace slugs are unavailable", async () => {
    mockPrisma.objective.findUnique.mockResolvedValue({ id: "obj-1", title: "Grow activation" })
    mockPrisma.keyResult.create.mockResolvedValue({ id: "kr-1", title: "Activation rate", target: 50, unit: null, current: 0 })
    const text = (await call("add_key_result", { objectiveId: "obj-1", title: "Activation rate", target: 50 })).content[0].text
    expect(text).toContain("ID: kr-1")
    expect(text).not.toContain("URL:")
  })
})

describe("create_experiment deeplink", () => {
  it("links to the experiment's own page", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(SLUGGED)
    mockPrisma.experiment.create.mockResolvedValue({ id: "exp-1", title: "Concierge onboarding", status: "DESIGNING", hypothesis: "h", method: "m", killCondition: "k", assumptionId: null, squadId: null })
    const text = (await call("create_experiment", { workspaceId: "ws-1", title: "Concierge onboarding", hypothesis: "h", method: "m", killCondition: "k" })).content[0].text
    expect(text).toContain(`URL: ${BASE}/experiments/exp-1`)
  })
})

describe("add_to_roadmap deeplink", () => {
  it("opens the roadmap item panel on the roadmap", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(SLUGGED)
    mockPrisma.roadmapItem.create.mockResolvedValue({ id: "item-1", title: "Ship payments", isPrivate: false, startDate: null, endDate: null, solutionId: null, keyResultId: null, opportunityId: null, squadId: null })
    const text = (await call("add_to_roadmap", { workspaceId: "ws-1", title: "Ship payments", horizon: "NEXT" })).content[0].text
    expect(text).toContain(`URL: ${BASE}/roadmap?detail=roadmapItem%3Aitem-1`)
  })
})

describe("promote_to_roadmap deeplink", () => {
  it("opens the new roadmap item panel on the roadmap", async () => {
    mockPrisma.solution.findUnique.mockResolvedValue({
      id: "sol-1", title: "Guided setup",
      opportunity: { id: "opp-1", title: "Setup is confusing", squadId: null, workspaceId: "ws-1", workspace: SLUGGED },
    })
    mockPrisma.roadmapItem.create.mockResolvedValue({ id: "item-2", title: "Guided setup", isPrivate: false, squadId: null })
    const text = (await call("promote_to_roadmap", { solutionId: "sol-1", workspaceId: "ws-1", horizon: "NOW" })).content[0].text
    expect(text).toContain(`URL: ${BASE}/roadmap?detail=roadmapItem%3Aitem-2`)
  })

  it("omits the URL line when the solution's opportunity belongs to a different workspace", async () => {
    mockPrisma.solution.findUnique.mockResolvedValue({
      id: "sol-1", title: "Guided setup",
      opportunity: { id: "opp-1", title: "Setup is confusing", squadId: null, workspaceId: "other-ws", workspace: SLUGGED },
    })
    mockPrisma.roadmapItem.create.mockResolvedValue({ id: "item-2", title: "Guided setup", isPrivate: false, squadId: null })
    const text = (await call("promote_to_roadmap", { solutionId: "sol-1", workspaceId: "ws-1", horizon: "NOW" })).content[0].text
    expect(text).toContain("Roadmap Item ID: item-2")
    expect(text).not.toContain("URL:")
  })
})
