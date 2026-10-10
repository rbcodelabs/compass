import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The visit store caches its parsed snapshot at module scope, so each test
 * re-imports a fresh module against a fresh fake localStorage.
 */
function fakeStorage(initial: Record<string, string> = {}, failWrites = false) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error("QuotaExceeded")
      data.set(k, v)
    },
    _data: data,
  }
}

async function load(storage: ReturnType<typeof fakeStorage>) {
  vi.resetModules()
  vi.stubGlobal("window", {
    localStorage: storage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  return import("@/components/workspace-selector/visits")
}

const KEY = "compass:workspace-visits"

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe("recordWorkspaceVisit", () => {
  it("persists a visit", async () => {
    const storage = fakeStorage()
    const { recordWorkspaceVisit } = await load(storage)
    recordWorkspaceVisit("org/ws", 1234)
    expect(JSON.parse(storage._data.get(KEY)!)).toEqual({ "org/ws": 1234 })
  })

  it("overwrites an earlier visit to the same workspace and keeps others", async () => {
    const storage = fakeStorage({ [KEY]: JSON.stringify({ "a/x": 1, "b/y": 2 }) })
    const { recordWorkspaceVisit } = await load(storage)
    recordWorkspaceVisit("a/x", 10)
    expect(JSON.parse(storage._data.get(KEY)!)).toEqual({ "a/x": 10, "b/y": 2 })
  })

  it("caps the log at 50 entries, dropping the oldest", async () => {
    const seed = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`o/w${i}`, i + 1]))
    const storage = fakeStorage({ [KEY]: JSON.stringify(seed) })
    const { recordWorkspaceVisit } = await load(storage)
    recordWorkspaceVisit("o/new", 999)
    const saved = JSON.parse(storage._data.get(KEY)!)
    expect(Object.keys(saved)).toHaveLength(50)
    expect(saved["o/new"]).toBe(999)
    expect(saved["o/w0"]).toBeUndefined()
  })

  it("swallows storage failures instead of throwing", async () => {
    const { recordWorkspaceVisit } = await load(fakeStorage({}, true))
    expect(() => recordWorkspaceVisit("a/x", 1)).not.toThrow()
  })
})

describe("stored data hygiene", () => {
  it.each([
    ["malformed JSON", "{nope"],
    ["an array", "[1,2]"],
    ["a scalar", "5"],
  ])("ignores %s and recovers on the next write", async (_label, raw) => {
    const storage = fakeStorage({ [KEY]: raw })
    const { recordWorkspaceVisit } = await load(storage)
    recordWorkspaceVisit("a/x", 7)
    expect(JSON.parse(storage._data.get(KEY)!)).toEqual({ "a/x": 7 })
  })

  it("drops non-numeric entries", async () => {
    const storage = fakeStorage({ [KEY]: JSON.stringify({ "a/x": "yesterday", "b/y": 5 }) })
    const { recordWorkspaceVisit } = await load(storage)
    recordWorkspaceVisit("c/z", 9)
    expect(JSON.parse(storage._data.get(KEY)!)).toEqual({ "b/y": 5, "c/z": 9 })
  })
})

describe("per-user scope", () => {
  it("writes under a key derived from the lowercased scope, leaving the base key alone", async () => {
    const storage = fakeStorage()
    const { recordWorkspaceVisit } = await load(storage)
    recordWorkspaceVisit("a/x", 5, "Dev@Example.com")
    expect(JSON.parse(storage._data.get(KEY + ":dev@example.com")!)).toEqual({ "a/x": 5 })
    expect(storage._data.has(KEY)).toBe(false)
  })

  it("keeps two users on the same browser isolated", async () => {
    const storage = fakeStorage()
    const { recordWorkspaceVisit } = await load(storage)
    recordWorkspaceVisit("a/x", 1, "one@x.com")
    recordWorkspaceVisit("b/y", 2, "two@x.com")
    expect(JSON.parse(storage._data.get(KEY + ":one@x.com")!)).toEqual({ "a/x": 1 })
    expect(JSON.parse(storage._data.get(KEY + ":two@x.com")!)).toEqual({ "b/y": 2 })
  })
})
