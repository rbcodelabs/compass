/**
 * app/api/discovery/export/route.ts — the Discovery page's CSV download.
 * Prisma, the workspace resolver and the filter/scoring helpers are mocked; the
 * assertions are about which filters reach the query and what lands in the file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getWorkspaceContext: vi.fn(),
  opportunityFindMany: vi.fn(),
  squadFindMany: vi.fn(),
  resolveCustomFieldFilter: vi.fn(),
  resolveWorkspaceScoringModel: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  default: () => ({
    opportunity: { findMany: mocks.opportunityFindMany },
    squad: { findMany: mocks.squadFindMany },
  }),
}))
vi.mock("@/lib/workspace-context", () => ({ getWorkspaceContext: mocks.getWorkspaceContext }))
vi.mock("@/lib/custom-field-filter", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/custom-field-filter")>()),
  resolveCustomFieldFilter: mocks.resolveCustomFieldFilter,
}))
vi.mock("@/lib/scoring-model", () => ({ resolveWorkspaceScoringModel: mocks.resolveWorkspaceScoringModel }))

import { GET } from "@/app/api/discovery/export/route"

const opp = (id: string, title: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  status,
  customerSegment: null,
  squadId: null,
  score: null,
  _count: { evidence: 1 },
  solutions: [{ id: `${id}-s1` }, { id: `${id}-s2` }],
  ...extra,
})

const call = (query = "") =>
  GET(new Request(`http://localhost/api/discovery/export?orgSlug=acme&workspaceSlug=ws${query}`))

const dataLines = async (res: Response) => (await res.text()).replace("﻿", "").trim().split("\r\n").slice(1)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getWorkspaceContext.mockResolvedValue({ status: "ok", workspace: { id: "ws1", name: "Growth Team" } })
  mocks.resolveCustomFieldFilter.mockResolvedValue(null)
  mocks.resolveWorkspaceScoringModel.mockResolvedValue(null)
  mocks.squadFindMany.mockResolvedValue([{ id: "sq1", name: "Checkout" }])
  mocks.opportunityFindMany.mockResolvedValue([])
})

describe("GET /api/discovery/export", () => {
  it("401s without a session, 404s for a non-member, 400s without params — and never queries", async () => {
    mocks.getWorkspaceContext.mockResolvedValueOnce({ status: "unauthenticated" })
    expect((await call()).status).toBe(401)
    mocks.getWorkspaceContext.mockResolvedValueOnce({ status: "not-found" })
    expect((await call()).status).toBe(404)
    expect((await GET(new Request("http://localhost/api/discovery/export"))).status).toBe(400)
    expect(mocks.opportunityFindMany).not.toHaveBeenCalled()
  })

  it("returns a private CSV attachment named for the workspace", async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toMatch(/^text\/csv/)
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="growth-team-opportunities-\d{4}-\d{2}-\d{2}\.csv"$/
    )
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("scopes the query to the workspace and applies the squad filter", async () => {
    await call("&squad=sq1")
    expect(mocks.opportunityFindMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws1", squadId: "sq1" })
    await call()
    expect(mocks.opportunityFindMany.mock.calls[1][0].where).toEqual({ workspaceId: "ws1" })
  })

  it("restricts to the tagged ids for an Opportunity-level tag filter", async () => {
    mocks.resolveCustomFieldFilter.mockResolvedValue({ fieldId: "f1", objectType: "OPPORTUNITY", objectIds: ["a", "b"] })
    await call("&field=f1&fieldValue=hot")
    expect(mocks.opportunityFindMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws1",
      id: { in: ["a", "b"] },
    })
  })

  it("lets a Solution-level tag narrow only the Solutions column", async () => {
    mocks.resolveCustomFieldFilter.mockResolvedValue({ fieldId: "f1", objectType: "SOLUTION", objectIds: ["o1-s2"] })
    mocks.opportunityFindMany.mockResolvedValue([opp("o1", "One", "EXPLORING")])
    const res = await call("&field=f1&fieldValue=hot")
    expect(mocks.opportunityFindMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws1" })
    expect((await dataLines(res))[0]).toContain(",1,1,") // 1 matching solution, 1 evidence
  })

  it("orders by board status with archived last, keeps manual order within a status, and resolves squad names", async () => {
    mocks.opportunityFindMany.mockResolvedValue([
      opp("a", "Archived one", "ARCHIVED"),
      opp("b", "Active one", "ACTIVE", { squadId: "sq1" }),
      opp("c", "Exploring first", "EXPLORING"),
      opp("d", "Exploring second", "EXPLORING"),
    ])
    const lines = await dataLines(await call())
    expect(lines.map((l) => l.split(",")[0])).toEqual([
      "Exploring first",
      "Exploring second",
      "Active one",
      "Archived one",
    ])
    expect(lines[2]).toContain(",ACTIVE,Checkout,")
  })

  it("emits a score only when a model is active", async () => {
    const scored = opp("a", "Scored", "EXPLORING", { score: { normalizedScore: 81, modelVersion: 1 } })
    mocks.opportunityFindMany.mockResolvedValue([scored])
    expect((await dataLines(await call()))[0]).toContain("Scored,EXPLORING,,,,")

    mocks.resolveWorkspaceScoringModel.mockResolvedValue({ version: 1 })
    expect((await dataLines(await call()))[0]).toContain("Scored,EXPLORING,,,81,")
  })
})
