/**
 * RFC 8707 `resource` handling — lenient on absence, strict on mismatch.
 *
 * The leniency is the part that needs guarding, because it looks like a bug:
 * the MCP spec says clients MUST send `resource`, and this server accepts
 * requests without it. That is deliberate (see lib/oauth/resource.ts) — the
 * Geode broker and `mcp-remote` both omit it, and rejecting would break the
 * primary consumer on day one. The security property is preserved by binding
 * the default audience onto the token and enforcing it at the resource server.
 *
 * The strictness is what these tests mostly cover: a token for someone else's
 * audience must never be mintable here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveResource } from "@/lib/oauth/resource"

const CANONICAL = "https://compass.example.com/api/mcp"

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://compass.example.com")
})
afterEach(() => vi.unstubAllEnvs())

describe("resolveResource", () => {
  it("defaults to the canonical MCP URI when absent", () => {
    for (const absent of [null, undefined, ""]) {
      expect(resolveResource(absent)).toEqual({ ok: true, resource: CANONICAL })
    }
  })

  it("accepts the canonical URI verbatim", () => {
    expect(resolveResource(CANONICAL)).toEqual({ ok: true, resource: CANONICAL })
  })

  it("accepts a single trailing slash and normalises it away", () => {
    // Clients differ on whether they echo the PRM document's `resource` exactly
    // or re-serialise it; both spellings address the same endpoint.
    expect(resolveResource(`${CANONICAL}/`)).toEqual({ ok: true, resource: CANONICAL })
  })

  it("rejects a different host", () => {
    const result = resolveResource("https://evil.example.com/api/mcp")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe("invalid_target")
  })

  it("rejects a different path on the same host", () => {
    expect(resolveResource("https://compass.example.com/api/other").ok).toBe(false)
    expect(resolveResource("https://compass.example.com/").ok).toBe(false)
  })

  it("rejects a subdomain of the canonical host", () => {
    expect(resolveResource("https://api.compass.example.com/api/mcp").ok).toBe(false)
  })

  it("rejects http where the canonical URI is https", () => {
    expect(resolveResource("http://compass.example.com/api/mcp").ok).toBe(false)
  })

  it("rejects a fragment, which RFC 8707 forbids outright", () => {
    const result = resolveResource(`${CANONICAL}#fragment`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.description).toMatch(/fragment/)
  })

  it("rejects a relative or malformed URI", () => {
    expect(resolveResource("/api/mcp").ok).toBe(false)
    expect(resolveResource("not a uri").ok).toBe(false)
  })

  it("names the one audience it will mint for, so a client can correct itself", () => {
    const result = resolveResource("https://evil.example.com/api/mcp")
    if (result.ok) return
    // The canonical URI is published in the PRM document, so echoing it leaks
    // nothing and turns a dead end into a retryable error.
    expect(result.description).toContain(CANONICAL)
    // But it must not echo the attacker's own value back.
    expect(result.description).not.toContain("evil.example.com")
  })

  it("follows the configured origin rather than a hardcoded host", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://other.example.com")
    expect(resolveResource(null)).toEqual({ ok: true, resource: "https://other.example.com/api/mcp" })
    expect(resolveResource(CANONICAL).ok).toBe(false)
  })
})
