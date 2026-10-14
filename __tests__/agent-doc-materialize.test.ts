import { describe, expect, it } from "vitest"
import {
  SANDBOX_MAX_DOCS,
  SANDBOX_MAX_NOTE_BYTES,
  SANDBOX_MAX_TOTAL_BYTES,
  selectMaterializable,
} from "@/lib/agent-doc-materialize"

const doc = (path: string, content = "x") => ({ path, content })

describe("selectMaterializable keeps docs the sandbox could not read back out of the baseline", () => {
  it("includes ordinary docs in order", () => {
    const { included, excluded } = selectMaterializable([doc("A"), doc("A/B")])
    expect(included.map((d) => d.path)).toEqual(["A", "A/B"])
    expect(excluded).toEqual([])
  })

  it("excludes a note over the wiki's 2 MiB read limit", () => {
    const big = doc("Big", "x".repeat(SANDBOX_MAX_NOTE_BYTES + 1))
    const { included, excluded } = selectMaterializable([big, doc("Small")])
    expect(included.map((d) => d.path)).toEqual(["Small"])
    expect(excluded).toEqual([{ path: "Big", reason: "too-large" }])
  })

  it("measures bytes, not characters", () => {
    const multibyte = doc("Jp", "日".repeat(Math.ceil(SANDBOX_MAX_NOTE_BYTES / 3) + 1))
    expect(selectMaterializable([multibyte]).excluded).toEqual([{ path: "Jp", reason: "too-large" }])
  })

  it("excludes docs nested past the wiki's depth limit", () => {
    const deep = doc(Array.from({ length: 31 }, (_, i) => `d${i}`).join("/"))
    expect(selectMaterializable([deep]).excluded).toEqual([{ path: deep.path, reason: "depth" }])
  })

  it("excludes any path the wiki walk would skip (dot-prefixed, node_modules), as a backstop to title escaping", () => {
    const { included, excluded } = selectMaterializable([doc(".secret"), doc("a/.b"), doc("a/node_modules/c"), doc("ok")])
    expect(included.map((d) => d.path)).toEqual(["ok"])
    expect(excluded.map((e) => e.reason)).toEqual(["excluded-name", "excluded-name", "excluded-name"])
  })

  it("stops at the entry budget instead of letting the wiki truncate its walk", () => {
    const docs = Array.from({ length: SANDBOX_MAX_DOCS + 3 }, (_, i) => doc(`Doc ${i}`))
    const { included, excluded } = selectMaterializable(docs)
    expect(included).toHaveLength(SANDBOX_MAX_DOCS)
    expect(excluded).toHaveLength(3)
    expect(excluded.every((e) => e.reason === "budget")).toBe(true)
    // 2 entries per doc (directory + file) must stay under the wiki's 10_000.
    expect(SANDBOX_MAX_DOCS * 2).toBeLessThan(10_000)
  })

  it("stops at the total byte budget", () => {
    const each = SANDBOX_MAX_NOTE_BYTES
    const count = Math.floor(SANDBOX_MAX_TOTAL_BYTES / each) + 2
    const { included, excluded } = selectMaterializable(Array.from({ length: count }, (_, i) => doc(`Doc ${i}`, "x".repeat(each))))
    expect(included.length).toBe(Math.floor(SANDBOX_MAX_TOTAL_BYTES / each))
    expect(excluded.every((e) => e.reason === "budget")).toBe(true)
  })
})
