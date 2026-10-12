import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CardSortTally } from "@/lib/card-sort"
import { CardSortError } from "@/lib/card-sort"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getWorkspace: vi.fn(),
  getCardSortTally: vi.fn(),
}))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/workspace", () => ({ getWorkspace: mocks.getWorkspace }))
vi.mock("@/lib/card-sort", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/card-sort")>()),
  getCardSortTally: mocks.getCardSortTally,
}))

import { buildCardSortCsv } from "@/lib/card-sort-export"
import { GET } from "@/app/api/card-sort/rounds/[roundId]/tally/export/route"

const tally: CardSortTally = {
  round: { id: "r1", name: "Q3 / MoSCoW", state: "REVEALED" as CardSortTally["round"]["state"], factorName: "Priority" },
  options: [
    { label: "Must Do", value: "must" },
    { label: "Could Do", value: "could" },
  ],
  objects: [
    {
      objectId: "o1",
      title: "Instant approval",
      currentValue: "could",
      targets: [
        {
          value: "must",
          count: 2,
          proposers: [
            { userId: "u1", userName: "Ada", rationale: "Blocks launch, really" },
            { userId: "u2", userName: "Bo", rationale: null },
          ],
        },
        { value: "gone_option", count: 1, proposers: [{ userId: "u3", userName: "=Cy", rationale: "x" }] },
      ],
      proposalCount: 3,
      distinctTargetCount: 2,
      unanimousMove: false,
    },
    {
      objectId: "o2",
      title: "Unset thing",
      currentValue: null,
      targets: [{ value: "could", count: 1, proposers: [{ userId: "u1", userName: "Ada", rationale: null }] }],
      proposalCount: 1,
      distinctTargetCount: 1,
      unanimousMove: false,
    },
  ],
  contested: [],
  flow: { edges: [], buckets: [], fromUnsetCount: 0 },
  participantCount: 3,
  proposalCount: 4,
}

const lines = (csv: string) => csv.replace("﻿", "").trim().split("\r\n")

describe("buildCardSortCsv", () => {
  it("writes one row per proposal with option labels, and the factor name in the headers", () => {
    const out = lines(buildCardSortCsv(tally))
    expect(out[0]).toBe(
      "Object,Current Priority,Proposed Priority,Proposer,Rationale,Proposals on this object,Different targets proposed"
    )
    expect(out).toHaveLength(1 + 4)
    expect(out[1]).toBe('Instant approval,Could Do,Must Do,Ada,"Blocks launch, really",3,2')
    expect(out[2]).toBe("Instant approval,Could Do,Must Do,Bo,,3,2")
  })

  it("falls back to the raw value for a stale option, blanks an unset current value, and defuses names", () => {
    const out = lines(buildCardSortCsv(tally))
    expect(out[3]).toBe("Instant approval,Could Do,gone_option,'=Cy,x,3,2")
    expect(out[4]).toBe("Unset thing,,Could Do,Ada,,1,1")
  })

  it("never invents rows for objects nobody proposed on", () => {
    const empty = { ...tally, objects: [], proposalCount: 0 }
    expect(lines(buildCardSortCsv(empty))).toHaveLength(1)
  })
})

describe("GET /api/card-sort/rounds/[roundId]/tally/export", () => {
  const call = (query = "?orgSlug=acme&workspaceSlug=ws") =>
    GET(new Request(`http://localhost/api/card-sort/rounds/r1/tally/export${query}`), {
      params: Promise.resolve({ roundId: "r1" }),
    })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { id: "u1" } })
    mocks.getWorkspace.mockResolvedValue({ id: "ws1" })
  })

  it("returns the CSV as a private attachment, scoped to the caller's workspace and user", async () => {
    mocks.getCardSortTally.mockResolvedValue(tally)
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toMatch(/^text\/csv/)
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="q3-moscow-tally-\d{4}-\d{2}-\d{2}\.csv"$/)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(await res.text()).toContain("Instant approval")
    expect(mocks.getCardSortTally).toHaveBeenCalledWith({ workspaceId: "ws1", roundId: "r1", userId: "u1" })
  })

  it("surfaces HIDDEN_UNTIL_REVEALED as 403 with no CSV and no proposal data", async () => {
    mocks.getCardSortTally.mockRejectedValue(
      new CardSortError("HIDDEN_UNTIL_REVEALED", "Proposals stay hidden until the round is revealed.")
    )
    const res = await call()
    expect(res.status).toBe(403)
    expect(res.headers.get("Content-Type")).not.toMatch(/csv/)
    expect(res.headers.get("Content-Disposition")).toBeNull()
    const body = await res.text()
    expect(body).toContain("HIDDEN_UNTIL_REVEALED")
    expect(body).not.toContain("Ada")
  })

  it("401s without a session and 404s for a non-member, never reading the tally", async () => {
    mocks.auth.mockResolvedValueOnce(null)
    expect((await call()).status).toBe(401)
    mocks.getWorkspace.mockResolvedValueOnce(null)
    expect((await call()).status).toBe(404)
    expect(mocks.getCardSortTally).not.toHaveBeenCalled()
  })

  it("400s when workspace params are missing", async () => {
    expect((await call("")).status).toBe(400)
    expect(mocks.getCardSortTally).not.toHaveBeenCalled()
  })
})
