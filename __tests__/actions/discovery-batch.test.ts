import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/work-item-sequence", async () => (await import("../helpers/work-item-sequence-mock")).workItemSequenceMock())

const { prisma, context, revalidate } = vi.hoisted(() => {
  const db = {
    opportunity: { findFirst: vi.fn(), create: vi.fn() },
    solution: { findFirst: vi.fn(), create: vi.fn() },
    squad: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  }
  db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) => callback(db))
  return {
    prisma: db,
    context: { current: null as unknown },
    revalidate: vi.fn(),
  }
})

vi.mock("@/lib/db", () => ({ default: vi.fn(() => prisma) }))
vi.mock("@/lib/analytics/activity", () => ({ getHumanActivityPrisma: () => prisma, getMcpActivityPrisma: () => prisma }))
vi.mock("next/cache", () => ({ revalidatePath: revalidate }))
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user-1" } })) }))
vi.mock("@/lib/product-action-auth", () => ({ requireProductWorkspace: vi.fn(), requireProductEntity: vi.fn(), requireProductWorkspaceBySlug: vi.fn() }))
vi.mock("@/lib/workspace-context", async () => {
  const { PermissionError } = await import("@/lib/permissions")
  return {
    requireWorkspaceContextOrThrow: vi.fn(async () => {
      if (!context.current) throw new PermissionError("Workspace not found")
      return context.current
    }),
    // Same rule as the real function (lib/workspace-context.ts).
    assertWorkspaceWritable: (ctx: { isReadOnly: boolean }) => {
      if (ctx.isReadOnly) throw new PermissionError("Forbidden: workspace is read-only")
    },
  }
})

import { createOpportunitiesBatch, createSolutionsBatch } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions"

const WS = "11111111-1111-4111-8111-111111111111"
const PARENT = "33333333-3333-4333-8333-333333333333"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const memberContext = (isReadOnly = false) => ({ userId: "user-1", workspace: { id: WS }, isReadOnly })

beforeEach(() => {
  vi.clearAllMocks()
  context.current = memberContext()
  prisma.opportunity.findFirst.mockResolvedValue(null)
  prisma.solution.findFirst.mockResolvedValue(null)
  prisma.opportunity.create.mockResolvedValue({ id: "x" })
  prisma.solution.create.mockResolvedValue({ id: "x" })
})

describe("createOpportunitiesBatch", () => {
  it("creates the items, returns per-item results and revalidates once", async () => {
    const result = await createOpportunitiesBatch("acme", "compass", [
      { clientId: id(1), title: "One" },
      { clientId: id(2), title: "" },
      { clientId: id(3), title: "Three" },
    ])
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error("unreachable")
    expect(result.results.map((r) => (r.ok ? "created" : r.code))).toEqual(["created", "INVALID", "created"])
    expect(prisma.opportunity.create).toHaveBeenCalledTimes(2)
    expect(prisma.opportunity.create.mock.calls[0][0].data).toMatchObject({ id: id(1), workspaceId: WS, source: "UI" })
    expect(revalidate).toHaveBeenCalledTimes(1)
  })

  it("refuses a read-only workspace before writing or revalidating", async () => {
    context.current = memberContext(true)
    await expect(createOpportunitiesBatch("acme", "compass", [{ clientId: id(1), title: "One" }])).rejects.toThrow("read-only")
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(revalidate).not.toHaveBeenCalled()
  })

  it("refuses a non-member (no workspace context) without writing", async () => {
    context.current = null
    await expect(createOpportunitiesBatch("acme", "compass", [{ clientId: id(1), title: "One" }])).rejects.toThrow("Workspace not found")
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("returns ok:false for more than 100 items and writes nothing", async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ clientId: id(i + 1), title: `T${i}` }))
    const result = await createOpportunitiesBatch("acme", "compass", items)
    expect(result).toMatchObject({ ok: false })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe("createSolutionsBatch", () => {
  it("creates solutions under a verified parent with the workspace set", async () => {
    prisma.opportunity.findFirst.mockResolvedValue({ id: PARENT })
    const result = await createSolutionsBatch("acme", "compass", [{ clientId: id(1), parent: { id: PARENT }, title: "Idea" }])
    expect(result).toMatchObject({ ok: true })
    expect(prisma.solution.create.mock.calls[0][0].data).toMatchObject({ id: id(1), workspaceId: WS, opportunityId: PARENT })
  })

  it("refuses a read-only workspace", async () => {
    context.current = memberContext(true)
    await expect(createSolutionsBatch("acme", "compass", [{ clientId: id(1), parent: { id: PARENT }, title: "Idea" }])).rejects.toThrow("read-only")
    expect(prisma.solution.create).not.toHaveBeenCalled()
  })
})
