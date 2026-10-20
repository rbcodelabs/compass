/**
 * The MCP/REST handlers now sit on the shared batch core (lib/opportunity-batch-create.ts). These pin the visible
 * behavior change for single-item `create_opportunity` / `add_solution` (payloads that used to pass and now fail), and
 * the agent cap on the bulk tools.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = vi.hoisted(() => {
  const db = {
    workspace: { findUnique: vi.fn() },
    opportunity: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    solution: { findFirst: vi.fn(), create: vi.fn() },
    squad: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  }
  db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) => callback(db))
  return db
})

vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/workspace-context", () => ({ assertWorkspaceWritable: vi.fn() }))

import { runWithMcpActor } from "@/lib/mcp-authz"
import { createOpportunities, createOpportunity } from "@/lib/opportunity-tool-handlers"
import { createSolution, createSolutions } from "@/lib/solution-tool-handlers"

const WS = "11111111-1111-4111-8111-111111111111"
const OPP = "33333333-3333-4333-8333-333333333333"
const asHuman = <T,>(run: () => Promise<T>) => runWithMcpActor({ userId: "user-1", purpose: "USER" }, run)
const asAgent = <T,>(run: () => Promise<T>) => runWithMcpActor({ userId: "user-1", purpose: "AGENT", agentId: "agent-1" }, run)
const text = (result: { content: Array<{ text: string }> }) => result.content[0].text

beforeEach(() => {
  vi.clearAllMocks()
  prisma.workspace.findUnique.mockResolvedValue({ id: WS, name: "Compass", slug: "compass", organization: { slug: "acme" } })
  prisma.opportunity.findFirst.mockResolvedValue(null)
  prisma.opportunity.findUnique.mockResolvedValue({ id: OPP, title: "Parent", workspaceId: WS, workspace: null })
  prisma.solution.findFirst.mockResolvedValue(null)
  prisma.squad.findFirst.mockResolvedValue(null)
  prisma.opportunity.create.mockResolvedValue({ id: "created" })
  prisma.solution.create.mockResolvedValue({ id: "created" })
})

describe("create_opportunity (single item, now on the shared core)", () => {
  // Each of these succeeded before the move (blank-after-trim and over-long values passed the zod schema, which only
  // checks min(1), and failed or wrote bad data later).
  it.each([
    ["a title that is only whitespace", { title: "   " }],
    ["a title over 255 characters", { title: "x".repeat(256) }],
    ["a customerSegment over 255 characters", { title: "ok", customerSegment: "s".repeat(256) }],
    ["a description over 10,000 characters", { title: "ok", description: "d".repeat(10_001) }],
  ])("now fails for %s and writes nothing", async (_label, payload) => {
    const result = await asHuman(() => createOpportunity({ workspaceId: WS, ...payload }))
    expect(result.structuredContent.ok).toBe(false)
    expect(prisma.opportunity.create).not.toHaveBeenCalled()
  })

  it("still accepts a valid payload and reports the created row", async () => {
    prisma.opportunity.findFirst
      .mockResolvedValueOnce(null) // sortOrder lane
      .mockResolvedValueOnce(null) // existence check in the transaction
      .mockResolvedValueOnce({ id: "created", title: "Trimmed", status: "EXPLORING", customerSegment: null, linkedKeyResultId: null, squadId: null })
    const result = await asHuman(() => createOpportunity({ workspaceId: WS, title: "  Trimmed  " }))
    expect(result.structuredContent.ok).toBe(true)
    expect(prisma.opportunity.create.mock.calls[0][0].data).toMatchObject({ workspaceId: WS, title: "Trimmed", source: "MCP" })
  })
})

describe("add_solution (single item, now on the shared core)", () => {
  it.each([
    ["a blank title", { title: " " }],
    ["a title over 255 characters", { title: "x".repeat(256) }],
    ["a description over 10,000 characters", { title: "ok", description: "d".repeat(10_001) }],
  ])("now fails for %s and writes nothing", async (_label, payload) => {
    const result = await asHuman(() => createSolution({ opportunityId: OPP, ...payload }))
    expect(result.structuredContent.ok).toBe(false)
    expect(prisma.solution.create).not.toHaveBeenCalled()
  })

  it("sets workspaceId from the parent's workspace", async () => {
    prisma.opportunity.findFirst.mockResolvedValue({ id: OPP })
    prisma.solution.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "created", title: "Idea", status: "IDEA" })
    const result = await asHuman(() => createSolution({ opportunityId: OPP, title: "Idea" }))
    expect(result.structuredContent.ok).toBe(true)
    expect(prisma.solution.create.mock.calls[0][0].data).toMatchObject({ workspaceId: WS, opportunityId: OPP })
  })
})

describe("bulk tools", () => {
  it("cap agent callers at 25 items and write nothing beyond the cap", async () => {
    const items = Array.from({ length: 26 }, (_, i) => ({ title: `Item ${i}` }))
    const result = await asAgent(() => createOpportunities({ workspaceId: WS, items }))
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toContain("at most 25")
    expect(prisma.opportunity.create).not.toHaveBeenCalled()
  })

  it("reports per-item results for a partial failure as a successful call", async () => {
    const items = [{ title: "Good" }, { title: "" }]
    const result = await asHuman(() => createOpportunities({ workspaceId: WS, items }))
    expect(result.structuredContent.ok).toBe(true)
    expect(result.structuredContent.data).toMatchObject({ created: 1, failed: 1 })
    expect(text(result)).toContain("1 opportunity created")
  })

  it("create_solutions reports NOT_FOUND for a parent outside the workspace", async () => {
    prisma.opportunity.findFirst.mockResolvedValue(null)
    const result = await asHuman(() => createSolutions({ workspaceId: WS, items: [{ parent: { id: OPP }, title: "Orphan" }] }))
    expect(result.structuredContent.data).toMatchObject({ created: 0, failed: 1 })
    expect(prisma.solution.create).not.toHaveBeenCalled()
  })
})
