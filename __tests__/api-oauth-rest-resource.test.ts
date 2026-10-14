import { describe, expect, it } from "vitest"
import {
  API_RESOURCE_SCOPES,
  SCOPE_API_READ,
  SCOPE_API_WRITE,
  apiResourceUri,
  scopesSatisfy,
} from "@/lib/oauth/constants"
import { resolveResource } from "@/lib/oauth/resource"
import { protectedResourceMetadata } from "@/lib/oauth/metadata"

describe("REST OAuth resource", () => {
  it("publishes a separate /api/v1 audience and API scopes", () => {
    expect(apiResourceUri()).toBe("http://localhost:3000/api/v1")
    expect(API_RESOURCE_SCOPES).toEqual([SCOPE_API_READ, SCOPE_API_WRITE])
    expect(protectedResourceMetadata("api")).toMatchObject({
      resource: "http://localhost:3000/api/v1",
      scopes_supported: ["api:read", "api:write"],
    })
  })

  it("keeps MCP and REST audiences distinct", () => {
    expect(resolveResource("http://localhost:3000/api/v1")).toEqual({ ok: true, resource: "http://localhost:3000/api/v1" })
    expect(resolveResource("http://localhost:3000/api/mcp")).toEqual({ ok: true, resource: "http://localhost:3000/api/mcp" })
  })

  it("makes write imply read only within the same scope family", () => {
    expect(scopesSatisfy(["api:write"], "api:read")).toBe(true)
    expect(scopesSatisfy(["mcp:write"], "api:read")).toBe(false)
    expect(scopesSatisfy(["api:write"], "mcp:read")).toBe(false)
  })
})
