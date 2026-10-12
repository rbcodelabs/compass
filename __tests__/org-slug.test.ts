import { describe, it, expect, vi } from "vitest"
import { readdirSync } from "node:fs"
import path from "node:path"
import {
  RESERVED_ORG_SLUGS,
  isReservedOrgSlug,
  validateOrgSlug,
  orgSlugSegmentIndex,
  resolveOrgSlugRedirect,
} from "@/lib/org-slug"

describe("validateOrgSlug", () => {
  it("accepts a normal slug", () => {
    expect(validateOrgSlug("acme-corp")).toBeNull()
    expect(validateOrgSlug("a1")).toBeNull()
  })

  it("rejects an empty slug", () => {
    expect(validateOrgSlug("")).toMatch(/required/i)
  })

  it.each(["Acme", "acme corp", "acme_corp", "acme/co", "acmé", "acme.co"])("rejects %s (shape)", (slug) => {
    expect(validateOrgSlug(slug)).toMatch(/lowercase letters, numbers, and hyphens/i)
  })

  it.each(["-acme", "acme-"])("rejects %s (leading or trailing hyphen)", (slug) => {
    expect(validateOrgSlug(slug)).toMatch(/start or end with a hyphen/i)
  })

  it("rejects a slug that is too short or too long", () => {
    expect(validateOrgSlug("a")).toMatch(/at least 2/i)
    expect(validateOrgSlug("a".repeat(64))).toMatch(/63 characters or fewer/i)
    expect(validateOrgSlug("a".repeat(63))).toBeNull()
  })

  it.each(["api", "portal", "login", "settings", "dashboard", "oauth"])("rejects reserved word %s", (slug) => {
    expect(validateOrgSlug(slug)).toMatch(/reserved/i)
  })
})

describe("RESERVED_ORG_SLUGS", () => {
  it("covers every static top-level route directory under app/", () => {
    const appDir = path.join(process.cwd(), "app")
    const staticSegments = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Route groups "(marketing)" add no URL segment; dynamic "[orgSlug]" is the org itself.
      .filter((name) => !name.startsWith("(") && !name.startsWith("["))
      // ".well-known" can never be a valid slug (the dot), so it needs no reservation.
      .filter((name) => /^[a-z0-9-]+$/.test(name))
    const missing = staticSegments.filter((name) => !isReservedOrgSlug(name))
    expect(missing).toEqual([])
  })

  it("is lowercase slug-shaped so it can actually collide with a valid slug", () => {
    for (const word of RESERVED_ORG_SLUGS) expect(word).toMatch(/^[a-z0-9-]+$/)
  })
})

describe("orgSlugSegmentIndex", () => {
  it.each([
    ["/acme/okrs", 0],
    ["/acme", 0],
    ["/acme/settings", 0],
    ["/portal/acme/ws/roadmap", 1],
    ["/api/portal/acme/ws/sso", 2],
  ])("%s -> %s", (pathname, index) => {
    expect(orgSlugSegmentIndex(pathname)).toBe(index)
  })

  it.each([
    "/",
    "/login",
    "/dashboard",
    "/api/mcp",
    "/api/v1/orgs/acme",
    "/_next/static/chunk.js",
    "/favicon.ico",
    "/help/02-discovery",
    "/portal",
    "/api/portal",
    "/api/portal/auth/send",
    "/Acme/okrs",
  ])("%s has no org segment", (pathname) => {
    expect(orgSlugSegmentIndex(pathname)).toBeNull()
  })
})

describe("resolveOrgSlugRedirect", () => {
  const lookup = vi.fn(async (slug: string) => (slug === "old-co" ? "new-co" : null))

  it("rewrites the org segment and preserves the rest of the path and the query", async () => {
    expect(await resolveOrgSlugRedirect("/old-co/ws/okrs", "?panel=1", lookup)).toBe("/new-co/ws/okrs?panel=1")
  })

  it("redirects the bare org root", async () => {
    expect(await resolveOrgSlugRedirect("/old-co", "", lookup)).toBe("/new-co")
  })

  it("redirects portal and portal API URLs, which customers hard-code", async () => {
    expect(await resolveOrgSlugRedirect("/portal/old-co/ws/roadmap", "", lookup)).toBe("/portal/new-co/ws/roadmap")
    expect(await resolveOrgSlugRedirect("/api/portal/old-co/ws/sso", "?token=abc", lookup)).toBe(
      "/api/portal/new-co/ws/sso?token=abc",
    )
  })

  it("preserves a trailing slash and percent-encoded later segments untouched", async () => {
    expect(await resolveOrgSlugRedirect("/old-co/ws/docs/a%20b/", "", lookup)).toBe("/new-co/ws/docs/a%20b/")
  })

  it("returns null for a slug with no history, without needing a path match", async () => {
    expect(await resolveOrgSlugRedirect("/never-existed/okrs", "", lookup)).toBeNull()
  })

  it("returns null and skips the lookup for non-org paths", async () => {
    lookup.mockClear()
    expect(await resolveOrgSlugRedirect("/api/mcp", "", lookup)).toBeNull()
    expect(await resolveOrgSlugRedirect("/login", "", lookup)).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })

  it("never redirects to the same slug (guards a live org that also has a stale history row)", async () => {
    expect(await resolveOrgSlugRedirect("/same/okrs", "", async () => "same")).toBeNull()
  })
})
