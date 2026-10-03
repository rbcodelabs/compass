import { describe, expect, it } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { resolveCustomerAvailability, resolveHomeForCustomer, resolveHomeForMember, resolveHomeForTeam } from "@/lib/portal-home/resolve"
import { createWidget, type PortalHomeWidget } from "@/lib/portal-home/schema"

/**
 * The leakage boundary: nothing non-public may reach a customer even if an admin
 * pinned it, and a widget the viewer may not see must not even be queried.
 * The fake below applies the same `where` semantics the resolvers rely on, so the
 * test fails if a resolver drops one of the public predicates.
 */
const WS = "11111111-1111-4111-8111-111111111111"
const OTHER_WS = "22222222-2222-4222-8222-222222222222"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

interface Item {
  id: string
  workspaceId: string
  title: string
  horizon: string
  status: string
  isPrivate: boolean
  sortOrder: number
  createdAt: Date
  updatedAt: Date
  startDate: Date | null
  endDate: Date | null
  // columns that must never be selected
  description: string
}
const d = (day: number) => new Date(Date.UTC(2026, 8, day))
const item = (n: number, over: Partial<Item>): Item => ({
  id: id(n), workspaceId: WS, title: `Item ${n}`, horizon: "NOW", status: "ACTIVE", isPrivate: false, sortOrder: n,
  createdAt: d(n), updatedAt: d(n), startDate: null, endDate: null, description: "INTERNAL DESCRIPTION", ...over,
})

const ITEMS: Item[] = [
  item(1, { title: "Public now" }),
  item(2, { title: "SECRET private now", isPrivate: true }),
  item(3, { title: "SECRET archived", status: "ARCHIVED" }),
  item(4, { title: "SECRET other workspace", workspaceId: OTHER_WS }),
  item(5, { title: "Public shipped", horizon: "SHIPPED", updatedAt: d(20) }),
  item(6, { title: "SECRET private shipped", horizon: "SHIPPED", isPrivate: true, updatedAt: d(25) }),
  item(7, { title: "Public launched", horizon: "LAUNCHED", updatedAt: d(22) }),
]

function matches(row: Item, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = (row as unknown as Record<string, unknown>)[key]
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown }
      if (c.in) return c.in.includes(value)
      if ("not" in c) return value !== c.not
    }
    return value === cond
  })
}
function project<T extends object>(rows: T[], select?: Record<string, boolean>) {
  if (!select) throw new Error("resolvers must always use an explicit select")
  return rows.map((row) => Object.fromEntries(Object.keys(select).map((k) => [k, (row as Record<string, unknown>)[k]])))
}

function fakePrisma(opts: { queries?: string[] } = {}) {
  const log = (name: string) => opts.queries?.push(name)
  return {
    roadmapItem: {
      findMany: async (args: { where: Record<string, unknown>; orderBy?: unknown; take?: number; select?: Record<string, boolean> }) => {
        log("roadmapItem")
        let rows = ITEMS.filter((r) => matches(r, args.where))
        const order = (args.orderBy as { updatedAt?: "desc" }[] | undefined)?.[0]
        rows = order?.updatedAt === "desc" ? rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()) : rows.sort((a, b) => a.sortOrder - b.sortOrder)
        return project(rows.slice(0, args.take ?? rows.length), args.select)
      },
    },
    feedbackItem: {
      findMany: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        log("feedbackItem")
        const rows = [
          { id: id(101), workspaceId: WS, title: "Popular idea", status: "OPEN", voteCount: 9 },
          { id: id(102), workspaceId: WS, title: "SECRET declined idea", status: "DECLINED", voteCount: 50 },
          { id: id(103), workspaceId: OTHER_WS, title: "SECRET other ws idea", status: "OPEN", voteCount: 99 },
        ].filter((r) => matches(r as never, args.where))
        return project(rows, args.select)
      },
    },
    doc: {
      findMany: async (args: { where: { workspaceId: string; id: { in: string[] } }; select?: Record<string, boolean> }) => {
        log("doc")
        const rows = [
          { id: id(201), workspaceId: WS, title: "Internal runbook" },
          { id: id(202), workspaceId: OTHER_WS, title: "SECRET other workspace doc" },
        ].filter((r) => matches(r as never, args.where as never))
        return project(rows, args.select)
      },
    },
  } as unknown as AppPrismaClient
}

const ctx = (over: Partial<{ roadmapPublic: boolean; feedbackEnabled: boolean }> = {}, queries?: string[]) => ({
  prisma: fakePrisma({ queries }),
  workspace: { id: WS, orgSlug: "acme", workspaceSlug: "main", roadmapPublic: true, feedbackEnabled: true, ...over },
})
const w = <T extends PortalHomeWidget>(widget: T, over: Partial<PortalHomeWidget> = {}) => ({ ...widget, ...over }) as T

describe("roadmap spotlight leakage boundary", () => {
  it("never returns private, archived or cross-workspace items, even when pinned", async () => {
    const widget = w(createWidget("roadmap_spotlight", 0), {
      config: { title: "Spot", show: "status", itemIds: [id(2), id(3), id(4), id(1), id(6)] },
    })
    const out = await resolveHomeForCustomer(ctx(), [widget], { signedIn: false })
    const json = JSON.stringify(out)
    expect(json).not.toContain("SECRET")
    expect(json).not.toContain("INTERNAL DESCRIPTION")
    const data = out.resolved[widget.id]
    expect(data.available && data.data.type === "roadmap_spotlight" && data.data.items.map((i) => i.id)).toEqual([id(1)])
  })

  it("is hidden entirely when every pinned item is non-public", async () => {
    const widget = w(createWidget("roadmap_spotlight", 0), { config: { title: "Spot", show: "status", itemIds: [id(2), id(3)] } })
    const out = await resolveHomeForCustomer(ctx(), [widget], { signedIn: false })
    expect(out.widgets).toEqual([])
  })

  it("makes no roadmap query and returns nothing when the roadmap is not public", async () => {
    const queries: string[] = []
    const widgets = [
      w(createWidget("roadmap_spotlight", 0), { config: { title: "Spot", show: "status", itemIds: [id(1)] } }),
      createWidget("recent_updates", 1),
    ]
    const out = await resolveHomeForCustomer(ctx({ roadmapPublic: false }, queries), widgets, { signedIn: true })
    expect(out.widgets).toEqual([])
    expect(queries).toEqual([])
  })

  it("keeps the admin's pin order", async () => {
    const widget = w(createWidget("roadmap_spotlight", 0), { config: { title: "Spot", show: "status", itemIds: [id(7), id(1), id(5)] } })
    const out = await resolveHomeForCustomer(ctx(), [widget], { signedIn: false })
    const data = out.resolved[widget.id]
    expect(data.available && data.data.type === "roadmap_spotlight" && data.data.items.map((i) => [i.id, i.statusLabel])).toEqual([
      [id(7), "Shipped"], [id(1), "Now"], [id(5), "Shipped"],
    ])
  })

  it("auto mode (nothing pinned) shows only public Now items", async () => {
    const widget = createWidget("roadmap_spotlight", 0)
    const out = await resolveHomeForCustomer(ctx(), [widget], { signedIn: false })
    expect(JSON.stringify(out)).not.toContain("SECRET")
    const data = out.resolved[widget.id]
    expect(data.available && data.data.type === "roadmap_spotlight" && data.data.items.map((i) => i.id)).toEqual([id(1)])
  })
})

describe("recent updates leakage boundary", () => {
  it("lists only public shipped items, newest first", async () => {
    const widget = w(createWidget("recent_updates", 0), { config: { title: "Shipped", limit: 10 } })
    const out = await resolveHomeForCustomer(ctx(), [widget], { signedIn: false })
    expect(JSON.stringify(out)).not.toContain("SECRET")
    const data = out.resolved[widget.id]
    expect(data.available && data.data.type === "recent_updates" && data.data.items.map((i) => i.id)).toEqual([id(7), id(5)])
  })
})

describe("feedback widget leakage boundary", () => {
  it("excludes declined and other-workspace ideas, and is hidden when feedback is off", async () => {
    const widget = createWidget("feedback_cta", 0)
    const out = await resolveHomeForCustomer(ctx(), [widget], { signedIn: false })
    expect(JSON.stringify(out)).not.toContain("SECRET")
    const data = out.resolved[widget.id]
    expect(data.available && data.data.type === "feedback_cta" && data.data.topIdeas.map((i) => i.id)).toEqual([id(101)])

    const queries: string[] = []
    const off = await resolveHomeForCustomer(ctx({ feedbackEnabled: false }, queries), [widget], { signedIn: false })
    expect(off.widgets).toEqual([])
    expect(queries).toEqual([])
  })
})

describe("key links: Docs are member-only", () => {
  const links = w(createWidget("key_links", 0), {
    config: {
      title: "Links",
      links: [
        { kind: "url", label: "Security", url: "https://example.com/security" },
        { kind: "doc", docId: id(201), label: "" },
        { kind: "doc", docId: id(202), label: "" },
      ],
    },
  })

  it("returns only external links to customers and never queries docs", async () => {
    const queries: string[] = []
    const out = await resolveHomeForCustomer(ctx({}, queries), [links], { signedIn: true })
    expect(queries).toEqual([])
    expect(JSON.stringify(out)).not.toContain("Internal runbook")
    const data = out.resolved[links.id]
    expect(data.available && data.data.type === "key_links" && data.data.links.map((l) => l.label)).toEqual(["Security"])
  })

  it("gives workspace members their own Docs only, never another workspace's", async () => {
    const resolved = await resolveHomeForMember(ctx(), [links])
    const json = JSON.stringify(resolved)
    expect(json).toContain("Internal runbook")
    expect(json).not.toContain("SECRET")
  })
})

describe("per-widget visibility is enforced before resolution", () => {
  it("does not resolve or return signed_in / segments widgets for a signed-out customer", async () => {
    const queries: string[] = []
    const widgets = [
      w(createWidget("feedback_cta", 0), { visibility: "signed_in" }),
      w(createWidget("recent_updates", 1), { visibility: "segments" }),
      w(createWidget("announcement", 2), { visibility: "everyone" }),
    ]
    const out = await resolveHomeForCustomer(ctx({}, queries), widgets, { signedIn: false })
    expect(out.widgets.map((x) => x.type)).toEqual(["announcement"])
    expect(Object.keys(out.resolved)).toEqual([widgets[2].id])
    expect(queries).toEqual([])
  })

  it("shows signed_in widgets to a signed-in customer but still never segments", async () => {
    const widgets = [
      w(createWidget("feedback_cta", 0), { visibility: "signed_in" }),
      w(createWidget("recent_updates", 1), { visibility: "segments" }),
    ]
    const out = await resolveHomeForCustomer(ctx(), widgets, { signedIn: true })
    expect(out.widgets.map((x) => x.type)).toEqual(["feedback_cta"])
  })
})

describe("member audience", () => {
  it("resolves internal data even when the public roadmap is off, and reports emptiness without blaming the public switch", async () => {
    const widget = createWidget("recent_updates", 0)
    const resolved = await resolveHomeForMember(ctx({ roadmapPublic: false }), [widget])
    expect(resolved[widget.id].available).toBe(true)
    const empty = await resolveHomeForMember(
      { ...ctx({ roadmapPublic: false }), prisma: { roadmapItem: { findMany: async () => [] } } as unknown as AppPrismaClient },
      [widget],
    )
    expect(empty[widget.id]).toEqual({ available: false, reason: "Nothing has shipped yet." })
  })

  it("customer availability reports the real customer verdict, with reasons, and returns no data", async () => {
    const roadmap = createWidget("recent_updates", 0)
    const feedback = createWidget("feedback_cta", 1)
    const teamOnly = w(createWidget("rich_text", 2), { visibility: "team" })
    const open = createWidget("announcement", 3)
    const off = await resolveCustomerAvailability(ctx({ roadmapPublic: false, feedbackEnabled: false }), [roadmap, feedback, teamOnly, open])
    expect(off[roadmap.id]).toEqual({ shown: false, reason: "The public roadmap is not enabled." })
    expect(off[feedback.id]).toEqual({ shown: false, reason: "The feedback portal is not enabled." })
    expect(off[teamOnly.id]).toEqual({ shown: false, reason: expect.stringContaining("Team only") })
    expect(off[open.id]).toEqual({ shown: true })
    const on = await resolveCustomerAvailability(ctx(), [roadmap, feedback])
    expect(on).toEqual({ [roadmap.id]: { shown: true }, [feedback.id]: { shown: true } })
    expect(JSON.stringify(on)).not.toContain("SECRET")
  })
})

describe("team-only widgets never reach a customer", () => {
  const teamNote = w(createWidget("rich_text", 0), { visibility: "team", config: { title: "TEAMONLY title", body: "TEAMONLY body" } })
  const teamLinks = w(createWidget("key_links", 1), {
    visibility: "team",
    config: { title: "TEAMONLY links", links: [{ kind: "doc", docId: id(201), label: "" }] },
  })
  const publicNote = w(createWidget("announcement", 2), { visibility: "everyone" })
  const layout = [teamNote, teamLinks, publicNote]

  it.each([
    ["signed-out customer", false],
    ["portal-signed-in customer", true],
  ])("a %s gets no team widget, no query runs for it and nothing is serialized", async (_name, signedIn) => {
    const queries: string[] = []
    const out = await resolveHomeForCustomer(ctx({}, queries), layout, { signedIn })
    expect(out.widgets.map((x) => x.id)).toEqual([publicNote.id])
    expect(Object.keys(out.resolved)).toEqual([publicNote.id])
    expect(queries).toEqual([])
    // This object is exactly what the page and the customer resolve route send to the browser.
    const wire = JSON.stringify(out)
    expect(wire).not.toContain("TEAMONLY")
    expect(wire).not.toContain(teamNote.id)
    expect(wire).not.toContain(teamLinks.id)
    expect(wire).not.toContain("Internal runbook")
  })

  it("the team sees team widgets and Doc links, but segments stays hidden", async () => {
    const segment = w(createWidget("rich_text", 3), { visibility: "segments", config: { title: "SEG", body: "SEG" } })
    const out = await resolveHomeForTeam(ctx(), [...layout, segment])
    expect(out.widgets.map((x) => x.id)).toEqual([teamNote.id, teamLinks.id, publicNote.id])
    expect(JSON.stringify(out.resolved)).toContain("Internal runbook")
    expect(out.resolved[segment.id]).toBeUndefined()
  })

})

describe("team home shows everything internal", () => {
  const flagsOff = { roadmapPublic: false, feedbackEnabled: false }

  it("with both public flags off, returns real private items, shipped items and top ideas, linked in-app", async () => {
    const spotlight = createWidget("roadmap_spotlight", 0)
    const recent = createWidget("recent_updates", 1)
    const feedback = createWidget("feedback_cta", 2)
    const out = await resolveHomeForTeam(ctx(flagsOff), [spotlight, recent, feedback])
    expect(out.widgets.map((x) => x.type)).toEqual(["roadmap_spotlight", "recent_updates", "feedback_cta"])

    const spot = out.resolved[spotlight.id]
    expect(spot.available && spot.data.type === "roadmap_spotlight" && spot.data.items.map((i) => i.id)).toEqual([id(1), id(2)])
    expect(spot.available && spot.data.type === "roadmap_spotlight" && spot.data.roadmapHref).toBe("/acme/main/roadmap")

    const upd = out.resolved[recent.id]
    expect(upd.available && upd.data.type === "recent_updates" && upd.data.items.map((i) => i.id)).toEqual([id(6), id(7), id(5)])
    expect(upd.available && upd.data.type === "recent_updates" && upd.data.roadmapHref).toBe("/acme/main/roadmap")

    const fb = out.resolved[feedback.id]
    expect(fb.available && fb.data.type === "feedback_cta" && fb.data.topIdeas.map((i) => i.id)).toEqual([id(101)])
    expect(fb.available && fb.data.type === "feedback_cta" && fb.data.feedbackHref).toBe("/acme/main/feedback")

    // Archived and other-workspace rows are still excluded, and declined ideas too.
    const json = JSON.stringify(out)
    expect(json).not.toContain("SECRET archived")
    expect(json).not.toContain("SECRET other")
    expect(json).not.toContain("SECRET declined")
  })

  it("lets the team pin a private item", async () => {
    const widget = w(createWidget("roadmap_spotlight", 0), { config: { title: "Spot", show: "status", itemIds: [id(2)] } })
    const out = await resolveHomeForTeam(ctx(flagsOff), [widget])
    const data = out.resolved[widget.id]
    expect(data.available && data.data.type === "roadmap_spotlight" && data.data.items.map((i) => i.id)).toEqual([id(2)])
  })
})

describe("customer boundary holds with the team change", () => {
  const privatePinned = w(createWidget("roadmap_spotlight", 0), {
    config: { title: "Spot", show: "status", itemIds: [id(2), id(6), id(1)] },
  })

  it("(a) roadmapPublic true + private item pinned in a published widget: it never appears, only the public one does", async () => {
    const out = await resolveHomeForCustomer(ctx({ roadmapPublic: true }), [privatePinned], { signedIn: true })
    const wire = JSON.stringify(out)
    expect(wire).not.toContain("SECRET private")
    expect(wire).not.toContain(id(2))
    expect(wire).not.toContain(id(6))
    const data = out.resolved[privatePinned.id]
    expect(data.available && data.data.type === "roadmap_spotlight" && data.data.items.map((i) => i.id)).toEqual([id(1)])
    // Links stay on the public portal.
    expect(wire).toContain("/portal/acme/main/roadmap")
    expect(wire).not.toContain('"/acme/main/roadmap"')
  })

  it("(a) the editor's customer-availability verdict never carries item data", async () => {
    const verdict = await resolveCustomerAvailability(ctx({ roadmapPublic: true }), [privatePinned])
    expect(JSON.stringify(verdict)).not.toMatch(/SECRET|00000000-0000-4000/)
  })

  it("(b) roadmapPublic false: roadmap widgets are dropped and no roadmapItem query is made", async () => {
    const queries: string[] = []
    const widgets = [privatePinned, createWidget("recent_updates", 1)]
    const out = await resolveHomeForCustomer(ctx({ roadmapPublic: false }, queries), widgets, { signedIn: true })
    expect(out.widgets).toEqual([])
    expect(queries).not.toContain("roadmapItem")
    expect(queries).toEqual([])
  })

  it("(c) feedback disabled: no feedbackItem query is made for customers", async () => {
    const queries: string[] = []
    const out = await resolveHomeForCustomer(ctx({ feedbackEnabled: false }, queries), [createWidget("feedback_cta", 0)], { signedIn: true })
    expect(out.widgets).toEqual([])
    expect(queries).not.toContain("feedbackItem")
  })

  it("the customer availability check makes no roadmap or feedback query when those surfaces are off", async () => {
    const queries: string[] = []
    await resolveCustomerAvailability(ctx({ roadmapPublic: false, feedbackEnabled: false }, queries), [privatePinned, createWidget("feedback_cta", 1)])
    expect(queries).toEqual([])
  })
})
