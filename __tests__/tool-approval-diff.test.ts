import { describe, expect, it } from "vitest"
import { COMPACT_ROW_LIMIT, MAX_DIFF_DEPTH, MAX_DIFF_NODES, MAX_DISPLAY_VALUE_CHARS, diffJson, formatValue, previewJson, reviewableInCard } from "@/lib/tool-approval/diff"

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


const deep = (levels: number, leaf: unknown = 1) => {
  let value: unknown = leaf
  for (let i = 0; i < levels; i += 1) value = { a: value }
  return value
}

describe("diffJson: keys are own properties only (B2)", () => {
  const own = (text: string) => JSON.parse(text) as never

  it("a key that only exists on Object.prototype is added, not walked as if both sides had it", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
      expect(kinds({}, { [key]: 1 }), key).toEqual([`added:${key}`])
      expect(kinds({ [key]: 1 }, {}), key).toEqual([`removed:${key}`])
      expect(kinds({ [key]: 1 }, { [key]: 2 }), key).toEqual([`changed:${key}`])
    }
  })

  it("an own __proto__ key (created by JSON.parse) diffs like any other key", () => {
    expect(kinds(own('{"__proto__":{"x":1}}'), own("{}"))).toEqual(["removed:__proto__.x"])
    expect(kinds(own("{}"), own('{"__proto__":{"x":1}}'))).toEqual(["added:__proto__.x"])
    expect(kinds(own('{"__proto__":{"x":1}}'), own('{"__proto__":{"x":2}}'))).toEqual(["changed:__proto__.x"])
  })

  it("does not pollute Object.prototype or the result objects", () => {
    diffJson(own('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}'), own("{}"))
    diffJson(own("{}"), own('{"__proto__":{"polluted":"yes"}}'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined()
    expect(Object.keys(Object.prototype)).toEqual([])
  })
})

describe("diffJson: depth and size caps (A1)", () => {
  it("10,000 levels of nesting never throw: the walk stops at the depth cap and says so", () => {
    const result = diffJson(deep(10_000, 1) as never, deep(10_000, 2) as never)
    expect(result.incomplete).toBe(true)
    const truncated = result.changed.filter((row) => row.kind === "truncated")
    expect(truncated.length).toBeGreaterThan(0)
    expect(truncated[0].path.split(".").length).toBeLessThanOrEqual(MAX_DIFF_DEPTH + 1)
    expect(result.changed.length).toBeLessThan(10)
  })

  it("a shape change against a very deep value formats without overflowing the stack", () => {
    const result = diffJson(deep(10_000) as never, "flat" as never)
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0].before!.length).toBeLessThan(3000)
  })

  it("a huge list of objects is cut at the node budget with one truncated row", () => {
    const big = Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `n${i}` }))
    const started = Date.now()
    const result = diffJson([] as never, big as never)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.incomplete).toBe(true)
    expect(result.changed.length).toBeLessThanOrEqual(MAX_DIFF_NODES + 1)
    expect(result.changed.some((row) => row.kind === "truncated")).toBe(true)
  })

  it("a huge list of plain values is compared in linear time and still cut", () => {
    const before = Array.from({ length: 100_000 }, (_, i) => i)
    const after = Array.from({ length: 100_000 }, (_, i) => i + 1)
    const started = Date.now()
    const result = diffJson({ n: before } as never, { n: after } as never)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result.incomplete).toBe(true)
  })

  it("a small value is complete", () => {
    expect(diffJson({ a: 1 }, { a: 2 }).incomplete).toBe(false)
  })
})

describe("previewJson", () => {
  it("returns the text and whether it was cut", () => {
    expect(previewJson({ a: 1 }, 100)).toEqual({ text: '{"a":1}', truncated: false })
    const cut = previewJson({ a: "x".repeat(500) }, 50)
    expect(cut.truncated).toBe(true)
    expect(cut.text.length).toBeLessThanOrEqual(80)
  })
  it("never throws on a value too deep to stringify", () => {
    const result = previewJson(deep(10_000) as never, 1000)
    expect(result.truncated).toBe(true)
  })
  it("pretty prints when asked", () => {
    expect(previewJson({ a: 1 }, 100, { pretty: true }).text).toBe('{\n  "a": 1\n}')
  })
})

describe("reviewableInCard (A3)", () => {
  it("is ok when every change and the arguments are shown", () => {
    expect(reviewableInCard({ a: 1 } as never, { a: 2 } as never, { x: 1 } as never)).toEqual({ ok: true })
  })
  it("is not ok when more than the compact limit of changes would be hidden", () => {
    const after = Object.fromEntries(Array.from({ length: COMPACT_ROW_LIMIT + 1 }, (_, i) => [`k${i}`, i]))
    const r = reviewableInCard({} as never, after as never, {} as never)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not all changes are shown/i)
  })
  it("is not ok when the diff was cut or the arguments are too long to show", () => {
    expect(reviewableInCard(deep(100) as never, deep(100, 2) as never, {} as never).ok).toBe(false)
    expect(reviewableInCard({ a: 1 } as never, { a: 2 } as never, { big: "x".repeat(9000) } as never)).toMatchObject({ ok: false, reason: expect.stringMatching(/arguments/i) })
  })
})
