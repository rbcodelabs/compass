import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db", () => ({ default: vi.fn() }))
vi.mock("@/lib/docs", () => ({ searchHelp: vi.fn().mockReturnValue([]) }))

import getPrisma from "@/lib/db"
import { searchHelp } from "@/lib/docs"
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
      where: { workspaceId: "workspace-1", title: { contains: "plan", mode: "insensitive" } },
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
    expect(searchHelp).toHaveBeenCalledWith("plan", 5)
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
    vi.mocked(searchHelp).mockReturnValue([
      {
        slug: "04-roadmap",
        title: "Roadmap",
        section: "Delivery",
        heading: "Not Yet on the Roadmap",
        anchor: "not-yet-on-the-roadmap",
        excerpt: "...",
        score: 8,
      },
    ])

    const result = await searchWorkspace({
      workspaceId: "workspace-1",
      orgSlug: "Acme Org",
      workspaceSlug: "Product/One",
      query: "plan",
    })

    expect(result.groups.map((group) => group.type)).toEqual([
      "opportunity", "solution", "experiment", "roadmapItem", "task", "feedback", "doc", "help",
    ])
    expect(result.groups.map((group) => group.label)).toEqual([
      "Opportunities", "Solutions", "Experiments", "Roadmap", "Tasks", "Feedback", "Docs", "User Guide",
    ])
    expect(result.groups.flatMap((group) => group.items)).toEqual([
      { type: "opportunity", id: "opp-1", displayId: null, title: "Plan onboarding", context: "ACTIVE", href: "/Acme%20Org/Product%2FOne/discovery/opp-1" },
      { type: "solution", id: "sol-1", displayId: null, title: "Planning wizard", context: "VALIDATED · Onboarding", href: "/Acme%20Org/Product%2FOne/discovery/opp-1?detail=solution%3Asol-1" },
      { type: "experiment", id: "exp-1", displayId: null, title: "Plan test", context: "RUNNING", href: "/Acme%20Org/Product%2FOne/experiments/exp-1" },
      { type: "roadmapItem", id: "road-1", displayId: null, title: "Plan launch", context: "NOW · ACTIVE", href: "/Acme%20Org/Product%2FOne/roadmap?detail=roadmapItem%3Aroad-1" },
      { type: "task", id: "task-1", displayId: null, title: "Plan QA", context: "TODO · HIGH", href: "/Acme%20Org/Product%2FOne/tasks/task-1" },
      { type: "feedback", id: "feed-1", displayId: null, title: "Plan request", context: "IDEA · OPEN", href: "/Acme%20Org/Product%2FOne/feedback?detail=feedback%3Afeed-1" },
      { type: "doc", id: "doc-1", displayId: null, title: "Plan notes", context: "STANDARD", href: "/Acme%20Org/Product%2FOne/docs/doc-1" },
      { type: "help", id: "04-roadmap:not-yet-on-the-roadmap", title: "Roadmap", context: "Not Yet on the Roadmap", href: "/help/04-roadmap#not-yet-on-the-roadmap" },
    ])
  })

  it("falls back to section and omits the anchor for whole-doc help matches", async () => {
    const prisma = prismaMock()
    vi.mocked(getPrisma).mockReturnValue(prisma as never)
    vi.mocked(searchHelp).mockReturnValue([
      {
        slug: "01-getting-started",
        title: "Getting Started",
        section: "Basics",
        heading: null,
        anchor: null,
        excerpt: "...",
        score: 3,
      },
    ])

    const result = await searchWorkspace({
      workspaceId: "workspace-1",
      orgSlug: "Acme Org",
      workspaceSlug: "Product/One",
      query: "plan",
    })

    const helpGroup = result.groups.find((group) => group.type === "help")
    expect(helpGroup?.items).toEqual([
      { type: "help", id: "01-getting-started:root", title: "Getting Started", context: "Basics", href: "/help/01-getting-started" },
    ])
  })

  it("shows display IDs and links to them for numbered rows, falling back to the UUID for the rest", async () => {
    const prisma = prismaMock()
    prisma.task.findMany.mockResolvedValue([
      { id: "t-uuid-1", title: "Plan QA", status: "TODO", priority: "HIGH", seqPrefix: "TASK", seqNumber: 12 },
      { id: "t-uuid-2", title: "Plan docs", status: "TODO", priority: "LOW", seqPrefix: null, seqNumber: null },
    ])
    vi.mocked(getPrisma).mockReturnValue(prisma as never)
    const result = await searchWorkspace({ workspaceId: "workspace-1", orgSlug: "acme", workspaceSlug: "product", query: "plan" })
    const tasks = result.groups.find((group) => group.type === "task")!.items
    expect(tasks.map((item) => [item.displayId, item.href])).toEqual([
      ["TASK-12", "/acme/product/tasks/TASK-12"],
      [null, "/acme/product/tasks/t-uuid-2"],
    ])
  })

  it("finds a row by its display ID, leads its group with it, and does not repeat it", async () => {
    const prisma = prismaMock()
    const hit = { id: "t-uuid-9", title: "Unrelated title", status: "DONE", priority: "LOW", seqPrefix: "TASK", seqNumber: 9 }
    prisma.task.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      "seqNumber" in args.where ? [hit] : [{ id: "t-other", title: "Other", status: "TODO", priority: "LOW", seqPrefix: "TASK", seqNumber: 3 }, hit])
    vi.mocked(getPrisma).mockReturnValue(prisma as never)
    const result = await searchWorkspace({ workspaceId: "workspace-1", orgSlug: "acme", workspaceSlug: "product", query: "task-9" })
    expect(prisma.task.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "workspace-1", seqPrefix: "TASK", seqNumber: 9 }, take: 1 }))
    expect(result.groups.find((group) => group.type === "task")!.items.map((item) => item.displayId)).toEqual(["TASK-9", "TASK-3"])
    // Only the matching type pays for an exact lookup.
    expect(prisma.opportunity.findMany).toHaveBeenCalledTimes(1)
  })

  it("ignores a display ID of a type that is not searchable here (objectives have no search group)", async () => {
    const prisma = prismaMock()
    vi.mocked(getPrisma).mockReturnValue(prisma as never)
    await searchWorkspace({ workspaceId: "workspace-1", orgSlug: "acme", workspaceSlug: "product", query: "OBJ-4" })
    for (const model of ["opportunity", "solution", "experiment", "roadmapItem", "task", "feedbackItem", "doc"] as const) expect(prisma[model].findMany).toHaveBeenCalledTimes(1)
  })
})
