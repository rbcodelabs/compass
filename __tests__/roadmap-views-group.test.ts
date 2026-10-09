import { describe, expect, it } from "vitest"
import { buildTimelineLayout, groupRoadmapItems } from "@/lib/roadmap-views/group"
import type { CrossWorkspaceRoadmapItem } from "@/lib/roadmap-views/query"

const WA = { id: "wa", name: "Alpha", slug: "alpha" }
const WB = { id: "wb", name: "Beta", slug: "beta" }

function item(id: string, over: Record<string, unknown> = {}): CrossWorkspaceRoadmapItem {
  return { id, title: id, horizon: "NOW", workspace: WA, squad: null, startDate: null, endDate: null, ...over } as unknown as CrossWorkspaceRoadmapItem
}

describe("groupRoadmapItems", () => {
  const items = [
    item("a", { horizon: "NOW" }),
    item("b", { horizon: "NEXT", workspace: WB }),
    item("c", { horizon: "SHIPPED" }),
  ]

  it("none: one group with everything", () => {
    const groups = groupRoadmapItems(items, "none", { horizons: [] })
    expect(groups).toHaveLength(1)
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b", "c"])
  })

  it("horizon: always shows Now/Next/Later, plus others only when populated", () => {
    const groups = groupRoadmapItems(items, "horizon", { horizons: [] })
    expect(groups.map((g) => g.key)).toEqual(["NOW", "NEXT", "LATER", "SHIPPED"])
    expect(groups.find((g) => g.key === "LATER")?.items).toEqual([])
  })

  it("horizon: a horizon filter limits the columns to exactly those horizons", () => {
    const groups = groupRoadmapItems(items, "horizon", { horizons: ["SHIPPED", "NOW"] })
    expect(groups.map((g) => g.key)).toEqual(["NOW", "SHIPPED"])
  })

  it("workspace: follows the supplied order, then name", () => {
    const groups = groupRoadmapItems(items, "workspace", { horizons: [] }, [WB, WA])
    expect(groups.map((g) => g.key)).toEqual(["wb", "wa"])
    expect(groups[1].items.map((i) => i.id)).toEqual(["a", "c"])
  })

  it("squad: disambiguates same-named squads by workspace and puts unassigned last", () => {
    const growthA = { id: "sa", name: "Growth", color: "#111111" }
    const growthB = { id: "sb", name: "Growth", color: "#222222" }
    const groups = groupRoadmapItems(
      [item("1", { squad: growthA }), item("2", { squad: growthB, workspace: WB }), item("3")],
      "squad",
      { horizons: [] },
    )
    expect(groups.map((g) => g.label)).toEqual(["Growth · Alpha", "Growth · Beta", "No squad"])
  })
})

describe("buildTimelineLayout", () => {
  it("is null when nothing is dated", () => {
    expect(buildTimelineLayout([{ startDate: null, endDate: null }])).toBeNull()
  })

  it("spans whole months and places items proportionally", () => {
    const layout = buildTimelineLayout([
      { startDate: "2026-01-10", endDate: "2026-01-20" },
      { startDate: "2026-03-05", endDate: "2026-03-05" },
    ] as never)!
    expect(layout.months.map((m) => m.key)).toEqual(["2026-01", "2026-02", "2026-03"])
    expect(layout.months.reduce((n, m) => n + m.widthPct, 0)).toBeCloseTo(100)
    const jan = layout.place({ startDate: "2026-01-10", endDate: "2026-01-20" } as never)!
    expect(jan.leftPct).toBeGreaterThan(0)
    expect(jan.leftPct + jan.widthPct).toBeLessThan(layout.months[0].widthPct + 0.01)
  })

  it("treats a one-sided item as a single day and never draws a zero-width bar", () => {
    const layout = buildTimelineLayout([{ startDate: "2026-01-01", endDate: null }, { startDate: null, endDate: "2026-12-31" }] as never)!
    expect(layout.place({ startDate: "2026-06-01", endDate: null } as never)!.widthPct).toBeGreaterThanOrEqual(0.8)
    expect(layout.place({ startDate: null, endDate: null } as never)).toBeNull()
  })

  it("normalises a reversed range", () => {
    const layout = buildTimelineLayout([{ startDate: "2026-02-20", endDate: "2026-02-10" }] as never)!
    const p = layout.place({ startDate: "2026-02-20", endDate: "2026-02-10" } as never)!
    expect(p.widthPct).toBeGreaterThan(0)
  })
})
