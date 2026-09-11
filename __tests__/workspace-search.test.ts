import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db", () => ({ default: vi.fn() }))

import getPrisma from "@/lib/db"
import {
  normalizeWorkspaceSearchQuery,
  searchWorkspace,
} from "@/lib/workspace-search"

const findMany = () => vi.fn().mockResolvedValue([])

function prismaMock() {
  return {
    opportunity: { findMany: findMany() },
    solution: { findMany: findMany() },
    experiment: { findMany: findMany() },
    roadmapItem: { findMany: findMany() },
    task: { findMany: findMany() },
    feedbackItem: { findMany: findMany() },
    doc: { findMany: findMany() },
  }
}

describe("workspace search", () => {
  beforeEach(() => vi.clearAllMocks())

  it("trims valid queries and rejects queries outside the 2-100 character bounds", () => {
    expect(normalizeWorkspaceSearchQuery("  roadmap  ")).toEqual({ ok: true, query: "roadmap" })
    expect(normalizeWorkspaceSearchQuery(" a ")).toEqual({ ok: false, reason: "too_short" })
    expect(normalizeWorkspaceSearchQuery("x".repeat(101))).toEqual({ ok: false, reason: "too_long" })
  })

  it("runs all seven bounded, stable, workspace-scoped title queries", async () => {
    const prisma = prismaMock()
    vi.mocked(getPrisma).mockReturnValue(prisma as never)

    await searchWorkspace({
      workspaceId: "workspace-1",
      orgSlug: "Acme Org",
      workspaceSlug: "Product/One",
      query: "plan",
    })

    expect(prisma.opportunity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-1", title: { contains: "plan", mode: "insensitive" } },
      take: 5,
      orderBy: [{ title: "asc" }, { id: "asc" }],
    }))
    expect(prisma.solution.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { opportunity: { workspaceId: "workspace-1" }, title: { contains: "plan", mode: "insensitive" } },
      take: 5,
      orderBy: [{ title: "asc" }, { id: "asc" }],
    }))
    for (const model of ["experiment", "roadmapItem", "task", "feedbackItem", "doc"] as const) {
      expect(prisma[model].findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { workspaceId: "workspace-1", title: { contains: "plan", mode: "insensitive" } },
        take: 5,
        orderBy: [{ title: "asc" }, { id: "asc" }],
      }))
    }
  })

  it("returns display-safe grouped results in fixed order with canonical destinations", async () => {
    const prisma = prismaMock()
    prisma.opportunity.findMany.mockResolvedValue([{ id: "opp-1", title: "Plan onboarding", status: "ACTIVE" }])
    prisma.solution.findMany.mockResolvedValue([{ id: "sol-1", title: "Planning wizard", status: "VALIDATED", opportunity: { id: "opp-1", title: "Onboarding" } }])
    prisma.experiment.findMany.mockResolvedValue([{ id: "exp-1", title: "Plan test", status: "RUNNING", conclusion: null }])
    prisma.roadmapItem.findMany.mockResolvedValue([{ id: "road-1", title: "Plan launch", status: "ACTIVE", horizon: "NOW" }])
    prisma.task.findMany.mockResolvedValue([{ id: "task-1", title: "Plan QA", status: "TODO", priority: "HIGH" }])
    prisma.feedbackItem.findMany.mockResolvedValue([{ id: "feed-1", title: "Plan request", status: "OPEN", type: "IDEA" }])
    prisma.doc.findMany.mockResolvedValue([{ id: "doc-1", title: "Plan notes", docType: "STANDARD" }])
    vi.mocked(getPrisma).mockReturnValue(prisma as never)

    const result = await searchWorkspace({
      workspaceId: "workspace-1",
      orgSlug: "Acme Org",
      workspaceSlug: "Product/One",
      query: "plan",
    })

    expect(result.groups.map((group) => group.type)).toEqual([
      "opportunity", "solution", "experiment", "roadmapItem", "task", "feedback", "doc",
    ])
    expect(result.groups.flatMap((group) => group.items)).toEqual([
      { type: "opportunity", id: "opp-1", title: "Plan onboarding", context: "ACTIVE", href: "/Acme%20Org/Product%2FOne/discovery/opp-1" },
      { type: "solution", id: "sol-1", title: "Planning wizard", context: "VALIDATED · Onboarding", href: "/Acme%20Org/Product%2FOne/discovery/opp-1?detail=solution%3Asol-1" },
      { type: "experiment", id: "exp-1", title: "Plan test", context: "RUNNING", href: "/Acme%20Org/Product%2FOne/experiments/exp-1" },
      { type: "roadmapItem", id: "road-1", title: "Plan launch", context: "NOW · ACTIVE", href: "/Acme%20Org/Product%2FOne/roadmap?detail=roadmapItem%3Aroad-1" },
      { type: "task", id: "task-1", title: "Plan QA", context: "TODO · HIGH", href: "/Acme%20Org/Product%2FOne/tasks/task-1" },
      { type: "feedback", id: "feed-1", title: "Plan request", context: "IDEA · OPEN", href: "/Acme%20Org/Product%2FOne/feedback?detail=feedback%3Afeed-1" },
      { type: "doc", id: "doc-1", title: "Plan notes", context: "STANDARD", href: "/Acme%20Org/Product%2FOne/docs/doc-1" },
    ])
  })
})
