import { describe, it, expect } from "vitest"
import { readdirSync } from "node:fs"
import path from "node:path"
import {
  RESERVED_ORG_SLUGS,
  isReservedOrgSlug,
  validateOrgSlug,
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
