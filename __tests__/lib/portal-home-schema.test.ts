import { describe, expect, it } from "vitest"
import { isSafeLinkUrl } from "@/lib/portal-home/fields"
import { createWidget, layoutSchema, normalizeOrder, parseStoredWidgets, WIDGET_TYPES, widgetSchema } from "@/lib/portal-home/schema"
import { isWidgetVisibleToCustomer, isWidgetVisibleToTeam } from "@/lib/portal-home/visibility"
import { buildDefaultWidgets } from "@/lib/portal-home/defaults"
import { hasUnpublishedChanges } from "@/lib/portal-home/schema"

describe("isSafeLinkUrl", () => {
  it.each(["https://example.com/a?b=1", "http://example.com", "/portal/acme/ws/roadmap"])("accepts %s", (url) => {
    expect(isSafeLinkUrl(url)).toBe(true)
  })
  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "//evil.example", "/\\evil.example", "ftp://x.test", "not a url", "https://a.test/ b", " https://a.test", ""])(
    "rejects %j",
    (url) => {
      expect(isSafeLinkUrl(url)).toBe(false)
    },
  )
})

describe("widget schema", () => {
  it("builds a valid default widget for every registered type", () => {
    for (const type of WIDGET_TYPES) {
      const widget = createWidget(type, 0)
      expect(widgetSchema.safeParse(widget).success, type).toBe(true)
    }
  })

  it("rejects an unknown widget type and an unsafe CTA url", () => {
    const base = createWidget("announcement", 0)
    expect(widgetSchema.safeParse({ ...base, type: "metric" }).success).toBe(false)
    expect(
      widgetSchema.safeParse({ ...base, config: { ...base.config, primaryCta: { label: "Go", url: "javascript:alert(1)" } } }).success,
    ).toBe(false)
  })

  it("rejects duplicate ids and oversize layouts on write", () => {
    const widget = createWidget("rich_text", 0)
    expect(layoutSchema.safeParse([widget, widget]).success).toBe(false)
    expect(layoutSchema.safeParse(Array.from({ length: 25 }, (_, i) => ({ ...createWidget("rich_text", i), id: `w${i}` }))).success).toBe(false)
  })

  it("stores 'segments' visibility but the field defaults to everyone", () => {
    const widget = createWidget("rich_text", 0)
    expect(widgetSchema.parse({ ...widget, visibility: "segments" }).visibility).toBe("segments")
    const withoutVisibility: Record<string, unknown> = { ...widget }
    delete withoutVisibility.visibility
    expect(widgetSchema.parse(withoutVisibility).visibility).toBe("everyone")
  })

  it("drops invalid stored widgets on read instead of failing, and sorts by order", () => {
    const a = { ...createWidget("rich_text", 2), id: "a" }
    const b = { ...createWidget("announcement", 0), id: "b" }
    const parsed = parseStoredWidgets([a, { type: "nope" }, b, { ...b }, "junk", null])
    expect(parsed.map((w) => w.id)).toEqual(["b", "a"])
    expect(parseStoredWidgets("not an array")).toEqual([])
    expect(parseStoredWidgets(null)).toEqual([])
  })
})

describe("isWidgetVisibleToCustomer", () => {
  it("applies everyone / signed_in and fails closed for segments", () => {
    expect(isWidgetVisibleToCustomer({ visibility: "everyone" }, { signedIn: false })).toBe(true)
    expect(isWidgetVisibleToCustomer({ visibility: "signed_in" }, { signedIn: false })).toBe(false)
    expect(isWidgetVisibleToCustomer({ visibility: "signed_in" }, { signedIn: true })).toBe(true)
    expect(isWidgetVisibleToCustomer({ visibility: "segments" }, { signedIn: true })).toBe(false)
    expect(isWidgetVisibleToCustomer({ visibility: "segments" }, { signedIn: false })).toBe(false)
  })
})

describe("team visibility", () => {
  it("is never visible to a customer, signed in or not, but is to the team", () => {
    expect(isWidgetVisibleToCustomer({ visibility: "team" }, { signedIn: false })).toBe(false)
    expect(isWidgetVisibleToCustomer({ visibility: "team" }, { signedIn: true })).toBe(false)
    expect(isWidgetVisibleToTeam({ visibility: "team" })).toBe(true)
    expect(isWidgetVisibleToTeam({ visibility: "everyone" })).toBe(true)
    expect(isWidgetVisibleToTeam({ visibility: "signed_in" })).toBe(true)
    expect(isWidgetVisibleToTeam({ visibility: "segments" })).toBe(false)
  })

  it("fails closed for an unknown visibility value on the customer path", () => {
    const unknown = { visibility: "future_value" } as unknown as { visibility: "team" }
    expect(isWidgetVisibleToCustomer(unknown, { signedIn: true })).toBe(false)
    expect(isWidgetVisibleToTeam(unknown)).toBe(false)
  })

  it("is backward compatible: a layout stored before 'team' existed still parses unchanged", () => {
    const old = [
      { ...createWidget("announcement", 0), id: "a", visibility: "everyone" },
      { ...createWidget("rich_text", 1), id: "b", visibility: "signed_in" },
      { ...createWidget("rich_text", 2), id: "c", visibility: "segments" },
    ]
    expect(layoutSchema.parse(old).map((w) => w.visibility)).toEqual(["everyone", "signed_in", "segments"])
    expect(parseStoredWidgets(old)).toHaveLength(3)
    expect(layoutSchema.parse([{ ...createWidget("rich_text", 0), visibility: "team" }])[0].visibility).toBe("team")
  })
})

describe("default layout", () => {
  const ctx = { workspaceName: "Acme", orgSlug: "o", workspaceSlug: "w", roadmapPublic: true, feedbackEnabled: true }
  it("is schema-valid and points the CTA at an enabled surface", () => {
    const widgets = buildDefaultWidgets(ctx)
    expect(layoutSchema.safeParse(widgets).success).toBe(true)
    expect(widgets[0].type === "announcement" && widgets[0].config.primaryCta?.url).toBe("/portal/o/w/roadmap")
    const feedbackOnly = buildDefaultWidgets({ ...ctx, roadmapPublic: false })
    expect(feedbackOnly[0].type === "announcement" && feedbackOnly[0].config.primaryCta?.url).toBe("/portal/o/w/feedback")
    const neither = buildDefaultWidgets({ ...ctx, roadmapPublic: false, feedbackEnabled: false })
    expect(neither[0].type === "announcement" && neither[0].config.primaryCta).toBeNull()
  })
  it("survives an absurdly long workspace name", () => {
    expect(layoutSchema.safeParse(buildDefaultWidgets({ ...ctx, workspaceName: "x".repeat(400) })).success).toBe(true)
  })
})

describe("hasUnpublishedChanges", () => {
  it("compares draft to published ignoring order gaps", () => {
    const a = createWidget("rich_text", 0)
    expect(hasUnpublishedChanges([], null)).toBe(false)
    expect(hasUnpublishedChanges([a], null)).toBe(true)
    expect(hasUnpublishedChanges([a], [a])).toBe(false)
    expect(hasUnpublishedChanges([{ ...a, order: 5 }], normalizeOrder([a]))).toBe(false)
    expect(hasUnpublishedChanges([{ ...a, size: "L" }], [a])).toBe(true)
  })
})

describe("hasUnpublishedChanges key order", () => {
  it("ignores object key order, as after a Zod round trip", () => {
    const a = createWidget("announcement", 0)
    const reparsed = widgetSchema.parse(JSON.parse(JSON.stringify(a)))
    expect(Object.keys(reparsed)).not.toEqual(Object.keys(a))
    expect(hasUnpublishedChanges([a], [reparsed])).toBe(false)
  })
})
