import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import * as nodeModule from "node:module"

// Present at runtime on the Node this repo targets (and on node24 in the sandbox)
// but not yet in @types/node, so it is reached through a narrow cast rather than a
// typed import.
const { stripTypeScriptTypes } = nodeModule as unknown as {
  stripTypeScriptTypes?: (source: string, options: { mode: "strip" }) => string
}

// The sandbox runs these files as `node entry.ts`, and Node only ERASES types —
// it never compiles them. Anything needing codegen (parameter properties, enums,
// namespaces, decorators, constructor overloads) throws
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at load, which kills the worker *before* its
// reporter exists: no heartbeat, no events, no error anywhere in Vercel's logs —
// the run just hangs until the sweeper reaps it as HEARTBEAT_STALE. A shipped
// parameter property did exactly that, so this asserts the same transform Node
// applies, which is the only check that reproduces the failure without a sandbox.
const dir = path.join(process.cwd(), "scripts/agent")
const entryScripts = readdirSync(dir).filter(name => name.endsWith("-entry.ts"))

describe("sandbox entry scripts are strip-only safe", () => {
  it("finds the entry scripts it is meant to guard", () => {
    // A rename that empties the list, or a Node without the transform, would make
    // every case below vacuously pass.
    expect(entryScripts).toContain("turn-entry.ts")
    expect(entryScripts.length).toBeGreaterThanOrEqual(2)
    expect(typeof stripTypeScriptTypes).toBe("function")
  })

  it.each(entryScripts)("%s loads under Node's type-stripping", name => {
    const source = readFileSync(path.join(dir, name), "utf8")
    expect(() => stripTypeScriptTypes!(source, { mode: "strip" })).not.toThrow()
  })
})
