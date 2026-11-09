import { describe, expect, it } from "vitest"
import { MAX_DISPLAY_VALUE_CHARS, diffJson, formatValue } from "@/lib/tool-approval/diff"

const kinds = (before: unknown, after: unknown) => diffJson(before as never, after as never).changed.map((r) => `${r.kind}:${r.path}`)

describe("diffJson", () => {
  it("shows a changed root scalar as one changed row", () => {
    const d = diffJson("old", "new")
    expect(d.changed).toEqual([{ path: "(value)", kind: "changed", before: '"old"', after: '"new"' }])
    expect(d.unchanged).toEqual([])
  })

  it("distinguishes null, an empty string and the text null", () => {
    const d = diffJson({ a: null, b: "", c: "null" }, { a: "", b: "null", c: null })
    expect(d.changed.map((r) => [r.path, r.before, r.after])).toEqual([["a", "null", '""'], ["b", '""', '"null"'], ["c", '"null"', "null"]])
  })

  it("walks nested objects to leaf paths and keeps untouched leaves as context", () => {
    const d = diffJson({ repo: { name: "a", owner: "me" }, n: 1 }, { repo: { name: "b", owner: "me" }, n: 1 })
    expect(d.changed.map((r) => r.path)).toEqual(["repo.name"])
    expect(d.unchanged.map((r) => r.path).sort()).toEqual(["n", "repo.owner"])
  })

  it("marks keys that appear as added and keys that disappear as removed, whole subtrees included", () => {
    expect(kinds({ keep: 1, gone: { x: 1, y: 2 } }, { keep: 1, fresh: { z: [1] } })).toEqual(["added:fresh.z[0]", "removed:gone.x", "removed:gone.y"])
  })

  it("treats a list of plain values as membership: only the added and removed members show", () => {
    const d = diffJson({ tags: ["a", "b", "c"] }, { tags: ["c", "a", "d"] })
    expect(d.changed.map((r) => [r.kind, r.path, r.before ?? r.after])).toEqual([["removed", "tags[]", '"b"'], ["added", "tags[]", '"d"']])
    expect(d.unchanged.length).toBe(2)
  })

  it("handles duplicate members by count", () => {
    expect(kinds({ t: ["a", "a"] }, { t: ["a"] })).toEqual(["removed:t[]"])
  })

  it("diffs lists of objects index by index, with extra items as added or removed", () => {
    expect(kinds({ r: [{ id: 1, on: true }, { id: 2 }] }, { r: [{ id: 1, on: false }] })).toEqual(["changed:r[0].on", "removed:r[1].id"])
    expect(kinds({ r: [] }, { r: [{ id: 9 }] })).toEqual(["added:r[0].id"])
    expect(kinds({ r: [{ id: 1 }] }, { r: [{ id: 1 }, { id: 2 }] })).toEqual(["added:r[1].id"])
  })

  it("shows a change of shape (object to text) as one changed row with both whole values", () => {
    const d = diffJson({ v: { a: 1 } }, { v: "flat" })
    expect(d.changed).toEqual([{ path: "v", kind: "changed", before: '{"a":1}', after: '"flat"' }])
  })

  it("quotes awkward keys so a path cannot be mistaken for a nested one", () => {
    expect(kinds({ "a.b": 1 }, { "a.b": 2 })).toEqual(['changed:"a.b"'])
  })

  it("reports no change for equal values", () => {
    const d = diffJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })
    expect(d.changed).toEqual([])
    expect(d.unchanged.length).toBeGreaterThan(0)
  })

  it("truncates a very long string and says how much was cut", () => {
    const long = "x".repeat(MAX_DISPLAY_VALUE_CHARS + 500)
    const text = formatValue(long)
    expect(text.length).toBeLessThan(MAX_DISPLAY_VALUE_CHARS + 80)
    expect(text).toMatch(/… \(\d+ more characters\)$/)
  })

  it("caps the number of changed rows and counts the overflow", () => {
    const after = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`k${String(i).padStart(3, "0")}`, i]))
    const d = diffJson({}, after)
    expect(d.changed.length).toBe(400)
    expect(d.omittedChanges).toBe(50)
  })

  it("keeps HTML-looking text as plain text in the row (escaping is the renderer's job)", () => {
    expect(diffJson({ n: "<b>x</b>" }, { n: "<img src=x onerror=alert(1)>" }).changed[0]).toMatchObject({ before: '"<b>x</b>"', after: '"<img src=x onerror=alert(1)>"' })
  })
})
