/**
 * The four `.well-known` route handlers.
 *
 * Two things here can only be caught at the route level, not in
 * oauth-metadata.test.ts:
 *
 *  1. **They must not touch the database.** A `getPrisma` that throws on call
 *     proves it — discovery has a 10 s client budget, and a cold Vercel function
 *     plus a DSQL IAM-signed connection can approach that on its own.
 *  2. **An unresolvable origin must be a 500, not a 404.** A 404 tells a client
 *     "this server does not support OAuth", which is false, and sends it down a
 *     no-authorization fallback instead of failing legibly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const initialize = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("a .well-known document must never reach the database")
  }),
)
vi.mock("@/lib/db", () => ({ default: initialize }))

import { GET as protectedResourceRoot, OPTIONS as protectedResourceOptions } from "@/app/.well-known/oauth-protected-resource/route"
import { GET as protectedResourceInserted } from "@/app/.well-known/oauth-protected-resource/api/mcp/route"
import { GET as authorizationServer } from "@/app/.well-known/oauth-authorization-server/route"
import { GET as openidConfiguration } from "@/app/.well-known/openid-configuration/route"
import { CONFIGURATION_ERROR_DESCRIPTION } from "@/lib/oauth/errors"

const ORIGIN = "https://compass.example.com"

beforeEach(() => {
  initialize.mockClear()
  vi.stubEnv("VERCEL_ENV", "")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN)
})
afterEach(() => vi.unstubAllEnvs())

const ALL = [
  ["protected resource (root)", protectedResourceRoot],
  ["protected resource (path-inserted)", protectedResourceInserted],
  ["authorization server", authorizationServer],
  ["openid-configuration", openidConfiguration],
] as const

describe.each(ALL)("%s", (_name, handler) => {
  it("serves the document without any database access", async () => {
    const response = await handler()
    expect(response.status).toBe(200)
    expect(initialize).not.toHaveBeenCalled()
  })

  it("is CORS-readable by a browser client", async () => {
    const response = await handler()
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
  })

  it("is edge-cacheable, to absorb a cold start inside the 10 s budget", async () => {
    const response = await handler()
    expect(response.headers.get("cache-control")).toMatch(/public, max-age=3600/)
  })

  it("contains no null values anywhere", async () => {
    // Claude Code Zod-fails on a null in these documents.
    const body = await (await handler()).json()
    for (const [key, value] of Object.entries(body)) {
      expect(value, `${key} must be omitted rather than nulled`).not.toBeNull()
    }
  })

  it("returns 500, never 404, when the origin cannot be resolved", async () => {
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")

    const response = await handler()
    expect(response.status).toBe(500)

    const body = await response.json()
    expect(body.error).toBe("server_error")
    // The body must not name the missing variable — these are world-readable.
    expect(body.error_description).toBe(CONFIGURATION_ERROR_DESCRIPTION)
    expect(JSON.stringify(body)).not.toMatch(/NEXT_PUBLIC_APP_URL|VERCEL/)
  })
})

describe("the two authorization-server spellings", () => {
  it("serve byte-identical documents", async () => {
    // Clients MUST support both and different ones probe different paths first;
    // a drift between them would make discovery depend on which was tried.
    const [a, b] = await Promise.all([authorizationServer(), openidConfiguration()])
    expect(await a.json()).toEqual(await b.json())
  })
})

describe("the two protected-resource locations", () => {
  it("serve byte-identical documents", async () => {
    const [root, inserted] = await Promise.all([
      protectedResourceRoot(),
      protectedResourceInserted(),
    ])
    expect(await root.json()).toEqual(await inserted.json())
  })

  it("name the canonical MCP resource", async () => {
    expect((await (await protectedResourceInserted()).json()).resource).toBe(`${ORIGIN}/api/mcp`)
  })
})

describe("CORS preflight", () => {
  it("answers 204 and allows GET", async () => {
    const response = await protectedResourceOptions()
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS")
    expect(initialize).not.toHaveBeenCalled()
  })
})
