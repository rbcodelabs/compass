/**
 * Regression test for the exact SDK behavior app/api/mcp/route.ts's
 * `docs://{workspaceId}/{+path}` resource template depends on (ADR 0019 §3.1).
 *
 * The spec flagged this as "confirm {+path} resolves as intended against the
 * installed SDK version before relying on it, as the very first thing done in
 * implementation" -- a bare `{path}` percent-encodes `/`, which would make a
 * multi-segment doc path un-matchable as a single variable. This locks the
 * confirmed behavior in as an automated check against the REAL SDK class
 * (not a hand-rolled regex), so a future SDK upgrade that changes URI template
 * semantics fails a test here instead of silently breaking doc resource reads.
 */
import { describe, expect, it } from "vitest"
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js"

describe("docs:// resource URI template", () => {
  const template = new UriTemplate("docs://{workspaceId}/{+path}")

  it("matches a multi-segment path as one variable, not one per segment", () => {
    const match = template.match("docs://11111111-1111-1111-1111-111111111111/Product/Roadmap/Q3%20Plan")
    expect(match).toEqual({
      workspaceId: "11111111-1111-1111-1111-111111111111",
      path: "Product/Roadmap/Q3%20Plan",
    })
  })

  it("matches a single-segment root-level path", () => {
    const match = template.match("docs://ws-1/Vision")
    expect(match).toEqual({ workspaceId: "ws-1", path: "Vision" })
  })

  it("does not match a URI missing the path variable entirely", () => {
    expect(template.match("docs://ws-1/")).toBeNull()
  })

  it("round-trips a path containing reserved characters through encodeURI/decodeURIComponent", () => {
    const original = "Product/Q3 Plan (draft)"
    const uri = `docs://ws-1/${encodeURI(original)}`
    const match = template.match(uri)
    expect(match).not.toBeNull()
    expect(decodeURIComponent(match!.path as string)).toBe(original)
  })
})
