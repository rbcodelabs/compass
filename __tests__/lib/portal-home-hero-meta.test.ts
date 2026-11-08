import { describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { heroMetaParts, loadPortalHeroMeta } from "@/lib/portal-home/hero-meta"

const day = (iso: string) => new Date(`${iso}T10:00:00Z`)

function prismaWith(opts: { now?: number; roadmapMax?: Date | null; docs?: number; docMax?: Date | null; docError?: unknown }) {
  const count = vi.fn(async () => opts.now ?? 0)
  const roadmapAggregate = vi.fn(async () => ({ _max: { updatedAt: opts.roadmapMax ?? null } }))
  const docAggregate = vi.fn(async () => {
    if (opts.docError) throw opts.docError
    return { _count: { _all: opts.docs ?? 0 }, _max: { updatedAt: opts.docMax ?? null } }
  })
  const prisma = { roadmapItem: { count, aggregate: roadmapAggregate }, doc: { aggregate: docAggregate } } as unknown as AppPrismaClient
  return { prisma, count, roadmapAggregate, docAggregate }
}

describe("loadPortalHeroMeta", () => {
  it("counts only public Now items and published docs, and dates the newest change of either", async () => {
    const { prisma, count, docAggregate } = prismaWith({ now: 6, roadmapMax: day("2026-11-05"), docs: 4, docMax: day("2026-11-07") })
    const meta = await loadPortalHeroMeta(prisma, { workspaceId: "w1", roadmapPublic: true, showDocs: true })
    expect(meta).toEqual({ updatedAt: day("2026-11-07").toISOString(), inProgress: 6, docs: 4 })
    // The queries are the public predicates: private/archived roadmap items and unpublished docs never count.
    expect(count).toHaveBeenCalledWith({ where: expect.objectContaining({ workspaceId: "w1", isPrivate: false, status: { not: "ARCHIVED" }, horizon: "NOW" }) })
    expect(docAggregate).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "w1", publishedAt: { not: null } }) }))
  })

  it("omits roadmap figures when the roadmap is not public and never queries it", async () => {
    const { prisma, count, roadmapAggregate } = prismaWith({ now: 9, roadmapMax: day("2026-11-09"), docs: 1, docMax: day("2026-11-02") })
    const meta = await loadPortalHeroMeta(prisma, { workspaceId: "w1", roadmapPublic: false, showDocs: true })
    expect(meta).toEqual({ updatedAt: day("2026-11-02").toISOString(), inProgress: null, docs: 1 })
    expect(count).not.toHaveBeenCalled()
    expect(roadmapAggregate).not.toHaveBeenCalled()
  })

  it("omits the docs count when the home has no docs widget, and zeros become nulls", async () => {
    const hidden = await loadPortalHeroMeta(prismaWith({ docs: 3, docMax: day("2026-11-02") }).prisma, { workspaceId: "w1", roadmapPublic: false, showDocs: false })
    expect(hidden.docs).toBeNull()
    const empty = await loadPortalHeroMeta(prismaWith({}).prisma, { workspaceId: "w1", roadmapPublic: true, showDocs: true })
    expect(empty).toEqual({ updatedAt: null, inProgress: null, docs: null })
  })

  it("treats an unapplied doc-publishing migration as nothing published, and rethrows other errors", async () => {
    const missing = Object.assign(new Error("column does not exist"), { code: "P2022" })
    const meta = await loadPortalHeroMeta(prismaWith({ now: 2, roadmapMax: day("2026-11-05"), docError: missing }).prisma, { workspaceId: "w1", roadmapPublic: true, showDocs: true })
    expect(meta).toEqual({ updatedAt: day("2026-11-05").toISOString(), inProgress: 2, docs: null })
    await expect(loadPortalHeroMeta(prismaWith({ docError: new Error("boom") }).prisma, { workspaceId: "w1", roadmapPublic: true, showDocs: true })).rejects.toThrow("boom")
  })
})

describe("heroMetaParts", () => {
  const fmt = (iso: string) => iso.slice(0, 10)
  it("is singular/plural aware and empty when there is nothing real to say", () => {
    expect(heroMetaParts({ updatedAt: "2026-11-05T00:00:00Z", inProgress: 1, docs: 1 }, fmt)).toEqual(["Updated 2026-11-05", "1 item in progress", "1 published doc"])
    expect(heroMetaParts({ updatedAt: null, inProgress: 2, docs: 5 }, fmt)).toEqual(["2 items in progress", "5 published docs"])
    expect(heroMetaParts({ updatedAt: null, inProgress: null, docs: null }, fmt)).toEqual([])
  })
})
