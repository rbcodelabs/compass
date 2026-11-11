import { describe, expect, it, vi } from "vitest"

const model = vi.hoisted(() => ({ value: { version: 2, status: "ACTIVE" } as { version: number; status: string } | null }))
vi.mock("@/lib/scoring-model", () => ({ resolveWorkspaceScoringModel: async () => model.value }))

import { loadObjectiveLinkedOpportunities } from "@/lib/objective-linked-opportunities"
import { getLinkedOpportunitiesByObjective } from "@/lib/typed-links"
import { createEntityLinkDelegate, entityLinkRow } from "./helpers/entity-link-fake"

const WS = "ws-1"
const t = (n: number) => new Date(2026, 0, n)

function fakeDb() {
  const opportunities = [
    { id: "o1", title: "Direct one", status: "ACTIVE", workspaceId: WS, score: { rawScore: 120, normalizedScore: 2, modelVersion: 2 } },
    { id: "o2", title: "Via KR", status: "EXPLORING", workspaceId: WS, score: null },
    { id: "o3", title: "Both", status: "PRIORITIZED", workspaceId: WS, score: { rawScore: 900, normalizedScore: 18, modelVersion: 1 } },
    { id: "foreign", title: "Other workspace", status: "ACTIVE", workspaceId: "ws-2", score: null },
  ]
  // entity_links is the only link store. The foreign opportunity's rows are stamped with this workspace (drift) and must still be hidden.
  const objectiveLink = (id: string, opportunityId: string, createdAt: Date) =>
    entityLinkRow({ id, workspaceId: WS, linkType: "OPPORTUNITY_TARGETS_OBJECTIVE", fromType: "OPPORTUNITY", fromId: opportunityId, toType: "OBJECTIVE", toId: "obj", origin: "DIRECT", createdAt })
  const pointer = (opportunityId: string) =>
    entityLinkRow({ workspaceId: WS, linkType: "OPPORTUNITY_TARGETS_KEY_RESULT", fromType: "OPPORTUNITY", fromId: opportunityId, toType: "KEY_RESULT", toId: "kr1" })
  const rows = [objectiveLink("l1", "o1", t(2)), objectiveLink("l2", "o3", t(1)), objectiveLink("l3", "foreign", t(3)), pointer("o2"), pointer("o3"), pointer("foreign")]
  return {
    objective: { findMany: async () => [{ id: "obj", title: "Objective" }] },
    keyResult: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => id === "kr1").map((id) => ({ id, title: "Signups" })) },
    entityLink: createEntityLinkDelegate(rows),
    opportunity: {
      findMany: async ({ where }: { where: { workspaceId: string; id?: { in: string[] } } }) =>
        opportunities.filter((o) => o.workspaceId === where.workspaceId && (!where.id || where.id.in.includes(o.id))),
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
    const db = fakeDb() as unknown as { entityLink: { findMany: () => Promise<unknown[]> } }
    db.entityLink.findMany = async () => []
    const result = await loadObjectiveLinkedOpportunities(db as never, WS, empty)
    expect(result).toEqual({ scoringActive: true, items: [] })
  })
})
