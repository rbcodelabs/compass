import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { EffectDiff } from "@/components/tool-approval/effect-diff"

const html = (before: unknown, after: unknown, props: { compact?: boolean; moreHref?: string } = {}) => renderToStaticMarkup(<EffectDiff before={before as never} after={after as never} {...props} />)

describe("EffectDiff", () => {
  it("renders before and after values for a changed field, with its path and a text label (not colour alone)", () => {
    const out = html({ description: "old text" }, { description: "new text" })
    expect(out).toContain("description")
    expect(out).toContain("Changed")
    expect(out).toContain("&quot;old text&quot;")
    expect(out).toContain("&quot;new text&quot;")
    expect(out).toContain('data-side="before"')
    expect(out).toContain('data-side="after"')
  })

  it("labels added and removed members of nested data and arrays", () => {
    const out = html({ repos: ["a/b", "c/d"], cfg: { keep: 1, gone: true } }, { repos: ["a/b", "e/f"], cfg: { keep: 1, fresh: 2 } })
    expect(out).toContain("Added")
    expect(out).toContain("Removed")
    expect(out).toContain("repos[]")
    expect(out).toContain("cfg.gone")
    expect(out).toContain("cfg.fresh")
    expect(out).toContain("(not set)")
    expect(out).toContain("(removed)")
  })

  it("escapes HTML-looking strings: they appear as text, never as markup", () => {
    const evil = '<script>alert("x")</script><img src=x onerror=alert(1)>'
    const out = html({ note: "safe" }, { note: evil })
    expect(out).not.toContain("<script")
    expect(out).not.toContain("<img")
    expect(out).toContain("&lt;script&gt;")
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;")
  })

  it("escapes HTML in paths (keys) too", () => {
    const out = html({ "<b>k</b>": 1 }, { "<b>k</b>": 2 })
    expect(out).not.toContain("<b>k")
    expect(out).toContain("&lt;b&gt;k&lt;/b&gt;")
  })

  it("keeps a very long value inside its own scrollable, wrapping box", () => {
    const out = html({ v: "a" }, { v: "b".repeat(5000) })
    expect(out).toContain("max-h-60")
    expect(out).toContain("overflow-auto")
    expect(out).toContain("[overflow-wrap:anywhere]")
    expect(out).toMatch(/more characters/)
  })

  it("says so when nothing differs", () => {
    expect(html({ a: 1 }, { a: 1 })).toContain("No visible change")
  })

  it("full mode puts unchanged context behind a collapsed control; compact mode omits it", () => {
    expect(html({ a: 1, b: 2 }, { a: 1, b: 3 })).toContain("1 unchanged value")
    expect(html({ a: 1, b: 2 }, { a: 1, b: 3 }, { compact: true })).not.toContain("unchanged value")
  })

  it("compact mode shows at most four changes and points at the full page for the rest", () => {
    const after = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`k${i}`, i]))
    const out = html({}, after, { compact: true, moreHref: "/o/w/approvals/x" })
    expect(out.match(/data-testid="effect-diff-row"/g)?.length).toBe(4)
    expect(out).toContain("3 more changes")
    expect(out).toContain('href="/o/w/approvals/x"')
  })

  it("tolerates a root scalar and a shape change", () => {
    expect(html("a", "b")).toContain("(value)")
    expect(html({ v: { a: 1 } }, { v: "flat" })).toContain("Changed")
  })
})
