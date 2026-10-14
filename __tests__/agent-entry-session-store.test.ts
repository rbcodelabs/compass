/**
 * MemorySessionStore in scripts/agent/turn-entry.ts.
 *
 * The entry script runs main() on load and is copied into the sandbox as one file, so
 * it cannot be imported. The class is sliced out of the source and evaluated with the
 * same type-stripping transform Node applies in the sandbox — which also proves the
 * slice itself is strip-only safe.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import * as nodeModule from "node:module"
import { gzipSync, gunzipSync } from "node:zlib"

const { stripTypeScriptTypes } = nodeModule as unknown as {
  stripTypeScriptTypes: (source: string, options: { mode: "strip" }) => string
}

type Entry = { type: string; uuid?: string; [k: string]: unknown }
type Key = { projectKey: string; sessionId: string; subpath?: string }
interface Store {
  mainSessionId: string | undefined
  size: number
  append(key: Key, entries: Entry[]): Promise<void>
  load(key: Key): Promise<Entry[] | null>
  listSubkeys(): Promise<string[]>
  toGzip(): Buffer
}
type StoreClass = { new (): Store; fromGzip(bytes: Buffer): Store | undefined }

function loadStoreClass(): StoreClass {
  const source = readFileSync(path.join(process.cwd(), "scripts/agent/turn-entry.ts"), "utf8")
  const start = source.indexOf("class MemorySessionStore")
  const end = source.indexOf("function readResumeStore")
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const limit = /const MAX_SESSION_INPUT_BYTES\s*=\s*[^\n]+/.exec(source)?.[0]
  expect(limit).toBeTruthy()
  const body = stripTypeScriptTypes(`${limit}\n${source.slice(start, end)}`, { mode: "strip" }) + "\nreturn MemorySessionStore"
  return new Function("gzipSync", "gunzipSync", "Buffer", body)(gzipSync, gunzipSync, Buffer) as StoreClass
}

const key = (over: Partial<Key> = {}): Key => ({ projectKey: "p", sessionId: "s1", ...over })

describe("MemorySessionStore", () => {
  const Store = loadStoreClass()

  it("records the main transcript's session id and ignores subagent paths for it", async () => {
    const store = new Store()
    await store.append(key({ sessionId: "sub", subpath: "subagents/agent-1" }), [{ type: "user", uuid: "a" }])
    expect(store.mainSessionId).toBeUndefined()
    await store.append(key({ sessionId: "main" }), [{ type: "user", uuid: "b" }])
    expect(store.mainSessionId).toBe("main")
  })

  it("dedupes a retried append by uuid, per subpath", async () => {
    const store = new Store()
    await store.append(key(), [{ type: "user", uuid: "a" }, { type: "assistant", uuid: "b" }])
    await store.append(key(), [{ type: "user", uuid: "a" }])
    await store.append(key({ subpath: "sub" }), [{ type: "user", uuid: "a" }])
    expect(store.size).toBe(3)
  })

  it("keeps entries without a uuid (they have no idempotency key to dedupe on)", async () => {
    const store = new Store()
    await store.append(key(), [{ type: "summary" }, { type: "summary" }])
    expect(store.size).toBe(2)
  })

  it("loads by subpath and returns null for an empty one", async () => {
    const store = new Store()
    await store.append(key(), [{ type: "user", uuid: "a" }])
    await store.append(key({ subpath: "sub" }), [{ type: "user", uuid: "b" }])
    expect(await store.load(key())).toEqual([{ type: "user", uuid: "a" }])
    expect(await store.load(key({ subpath: "sub" }))).toEqual([{ type: "user", uuid: "b" }])
    expect(await store.load(key({ subpath: "none" }))).toBeNull()
    expect(await store.listSubkeys()).toEqual(["sub"])
  })

  it("round-trips through gzip, including dedupe state for the resumed turn", async () => {
    const store = new Store()
    await store.append(key(), [{ type: "user", uuid: "a", message: "héllo\nworld" }])
    await store.append(key({ subpath: "sub" }), [{ type: "assistant", uuid: "b" }])

    const restored = Store.fromGzip(store.toGzip())!
    expect(restored.size).toBe(2)
    expect(await restored.load(key())).toEqual([{ type: "user", uuid: "a", message: "héllo\nworld" }])
    expect(await restored.listSubkeys()).toEqual(["sub"])
    // The restored store must not re-add an entry it already holds.
    await restored.append(key(), [{ type: "user", uuid: "a" }])
    expect(restored.size).toBe(2)
  })

  it("rejects anything that is not a well-formed transcript instead of resuming from it", () => {
    const line = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value) + "\n"))
    expect(Store.fromGzip(Buffer.from("not gzip"))).toBeUndefined()
    expect(Store.fromGzip(gzipSync(Buffer.from("{bad json\n")))).toBeUndefined()
    expect(Store.fromGzip(gzipSync(Buffer.from("")))).toBeUndefined()
    expect(Store.fromGzip(line({ s: null, e: { uuid: "x" } }))).toBeUndefined() // entry.type missing
    expect(Store.fromGzip(line({ s: 5, e: { type: "user" } }))).toBeUndefined() // bad subpath
    expect(Store.fromGzip(line(null))).toBeUndefined()
  })
})
