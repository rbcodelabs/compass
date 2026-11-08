import { describe, expect, it, vi } from "vitest"

const model = vi.hoisted(() => ({ value: { version: 2, status: "ACTIVE" } as { version: number; status: string } | null }))
vi.mock("@/lib/scoring-model", () => ({ resolveWorkspaceScoringModel: async () => model.value }))

import { loadObjectiveLinkedOpportunities } from "@/lib/objective-linked-opportunities"
import { getLinkedOpportunitiesByObjective } from "@/lib/typed-links"

const WS = "ws-1"
const t = (n: number) => new Date(2026, 0, n)

function fakeDb() {
  const opportunities = [
    { id: "o1", title: "Direct one", status: "ACTIVE", workspaceId: WS, linkedKeyResultId: null, score: { rawScore: 120, normalizedScore: 2, modelVersion: 2 } },
    { id: "o2", title: "Via KR", status: "EXPLORING", workspaceId: WS, linkedKeyResultId: "kr1", score: null },
    { id: "o3", title: "Both", status: "PRIORITIZED", workspaceId: WS, linkedKeyResultId: "kr1", score: { rawScore: 900, normalizedScore: 18, modelVersion: 1 } },
    { id: "foreign", title: "Other workspace", status: "ACTIVE", workspaceId: "ws-2", linkedKeyResultId: "kr1", score: null },
  ]
  const links = [
    { id: "l1", workspaceId: WS, opportunityId: "o1", objectiveId: "obj", createdAt: t(2) },
    { id: "l2", workspaceId: WS, opportunityId: "o3", objectiveId: "obj", createdAt: t(1) },
    { id: "l3", workspaceId: WS, opportunityId: "foreign", objectiveId: "obj", createdAt: t(3) },
  ]
  const inWs = (rows: typeof opportunities, where: Record<string, unknown>) =>
    rows.filter((r) => (where.workspaceId ? r.workspaceId === where.workspaceId : true))
  return {
    objective: { findMany: async () => [{ id: "obj" }] },
    opportunityObjectiveLink: {
      findMany: async ({ where }: { where: { workspaceId: string; objectiveId: { in: string[] } } }) =>
        links.filter((l) => l.workspaceId === where.workspaceId && where.objectiveId.in.includes(l.objectiveId)),
    },
    opportunity: {
      findMany: async ({ where }: { where: { workspaceId: string; id?: { in: string[] }; linkedKeyResultId?: { in: string[] } } }) =>
        inWs(opportunities, where).filter(
          (o) => (!where.id || where.id.in.includes(o.id)) && (!where.linkedKeyResultId || where.linkedKeyResultId.in.includes(o.linkedKeyResultId ?? "")),
        ),
    },
  } as never
}

const objective = { id: "obj", keyResults: [{ id: "kr1", title: "Signups" }] }

describe("getLinkedOpportunitiesByObjective", () => {
  it("returns workspace-filtered opportunities ordered by link creation", async () => {
    const map = await getLinkedOpportunitiesByObjective(fakeDb(), WS, ["obj"])
    expect(map.get("obj")).toEqual([
      { id: "o3", title: "Both" },
      { id: "o1", title: "Direct one" },
    ])
  })
})

describe("loadObjectiveLinkedOpportunities", () => {
  it("merges direct and key-result links, dedupes and sorts by raw score", async () => {
    model.value = { version: 2, status: "ACTIVE" }
    const result = await loadObjectiveLinkedOpportunities(fakeDb(), WS, objective)
    expect(result.scoringActive).toBe(true)
    expect(result.items.map((i) => i.id)).toEqual(["o3", "o1", "o2"])
    expect(result.items[0]).toMatchObject({ direct: true, viaKeyResults: [{ id: "kr1", title: "Signups" }], scoreStale: true })
    expect(result.items.some((i) => i.id === "foreign")).toBe(false)
  })

  it.each(["CLASSIC", "OPPORTUNITY_FIRST_OKR", "TORRES_OST"])("returns both direct and key-result links under the %s preset (the preset never filters data)", async () => {
    // The loader takes no preset input: Classic and Torres hide one kind in the UI but both kinds are real links.
    const result = await loadObjectiveLinkedOpportunities(fakeDb(), WS, objective)
    expect(result.items.map((i) => i.id).sort()).toEqual(["o1", "o2", "o3"])
    expect(result.items.find((i) => i.id === "o1")).toMatchObject({ direct: true, viaKeyResults: [] })
    expect(result.items.find((i) => i.id === "o2")).toMatchObject({ direct: false, viaKeyResults: [{ id: "kr1" }] })
  })

  it("treats an assigned but ARCHIVED model as no active model (no score fields)", async () => {
    model.value = { version: 2, status: "ARCHIVED" }
    const result = await loadObjectiveLinkedOpportunities(fakeDb(), WS, objective)
    expect(result.scoringActive).toBe(false)
    expect(result.items.every((i) => !("rawScore" in i))).toBe(true)
  })

  it("omits scores when the workspace has no active Opportunity model", async () => {
    model.value = null
    const result = await loadObjectiveLinkedOpportunities(fakeDb(), WS, objective)
    expect(result.scoringActive).toBe(false)
    expect(result.items.every((i) => !("rawScore" in i))).toBe(true)
  })

  it("returns an empty list for an objective with no links", async () => {
    model.value = { version: 1, status: "ACTIVE" }
    const empty = { id: "obj2", keyResults: [] }
    const db = fakeDb() as unknown as { opportunityObjectiveLink: { findMany: () => Promise<unknown[]> } }
    db.opportunityObjectiveLink.findMany = async () => []
    const result = await loadObjectiveLinkedOpportunities(db as never, WS, empty)
    expect(result).toEqual({ scoringActive: true, items: [] })
  })
})
