/**
 * The consent step's signing, CSRF binding, and remembered approval.
 *
 * The property that matters most: the *authorization request* carries no
 * unsigned fields. Everything that decides what is being authorized lives
 * inside an HMAC bound to one signed-in user, so a cross-site form cannot mint
 * one and the redirect URI cannot be rewritten between the screen the user read
 * and the code that is issued. (ADR 0015 adds unsigned *binding* fields, which
 * are re-validated server-side instead — see oauth-agent-binding-consent.test.ts.)
 *
 * There is no consent cookie any more, and the tests that covered it are gone
 * with it rather than being rewritten. A remembered approval now carries a
 * binding, and a security-relevant decision may not live in 90-day client state
 * that no server-side migration can revoke. `OAuthConsent` is the only record,
 * and the assertion that replaced those tests is that approving writes no
 * cookie at all (api-oauth-consent-route.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createOAuthStore } from "../helpers/oauth-store"

const store = createOAuthStore()
vi.mock("@/lib/db", () => ({ default: () => store.prisma }))

import {
  CONSENT_REQUEST_TTL_MS,
  findStoredConsent,
  grantedAccess,
  recordConsent,
  scopeCovers,
  signAuthorizationRequest,
  verifyAuthorizationRequest,
} from "@/lib/oauth/consent"

const REQUEST = {
  clientId: "cmp_oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  redirectUri: "http://127.0.0.1:54321/callback",
  state: "abc123",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256",
  scope: "mcp:read mcp:write",
  resource: "https://compass.example.com/api/mcp",
}

beforeEach(() => {
  store.reset()
  vi.stubEnv("AUTH_SECRET", "test-signing-secret-value")
})
afterEach(() => vi.unstubAllEnvs())

describe("the signed authorization request", () => {
  it("round-trips for the user it was signed for", () => {
    const blob = signAuthorizationRequest(REQUEST, "user-1")
    expect(verifyAuthorizationRequest(blob, "user-1")).toEqual(REQUEST)
  })

  it("is rejected for a different user — this is the CSRF property", () => {
    const blob = signAuthorizationRequest(REQUEST, "user-1")
    // A blob captured from someone else's consent screen is worthless, and a
    // third-party site has no way to mint one at all.
    expect(verifyAuthorizationRequest(blob, "user-2")).toBeNull()
  })

  it("is rejected when the payload is edited", () => {
    const blob = signAuthorizationRequest(REQUEST, "user-1")
    const [payload, signature] = blob.split(".")
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    // The classic attack: the screen says 127.0.0.1, the submit says evil.com.
    decoded.redirectUri = "https://evil.example.com/callback"
    const forged = `${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}.${signature}`

    expect(verifyAuthorizationRequest(forged, "user-1")).toBeNull()
  })

  it("is rejected when the signature is replaced", () => {
    const [payload] = signAuthorizationRequest(REQUEST, "user-1").split(".")
    expect(verifyAuthorizationRequest(`${payload}.not-a-signature`, "user-1")).toBeNull()
  })

  it("is rejected once it expires", () => {
    const issued = new Date("2026-09-18T12:00:00Z")
    const blob = signAuthorizationRequest(REQUEST, "user-1", issued)

    const justInside = new Date(issued.getTime() + CONSENT_REQUEST_TTL_MS - 1)
    const justOutside = new Date(issued.getTime() + CONSENT_REQUEST_TTL_MS + 1)
    expect(verifyAuthorizationRequest(blob, "user-1", justInside)).not.toBeNull()
    expect(verifyAuthorizationRequest(blob, "user-1", justOutside)).toBeNull()
  })

  it("is rejected when signed under a different key", () => {
    const blob = signAuthorizationRequest(REQUEST, "user-1")
    vi.stubEnv("AUTH_SECRET", "a-completely-different-secret")
    expect(verifyAuthorizationRequest(blob, "user-1")).toBeNull()
  })

  it("handles absent, empty and malformed input without throwing", () => {
    for (const bad of [null, undefined, "", ".", "no-dot", "a.b.c", "x".repeat(9000)]) {
      expect(verifyAuthorizationRequest(bad, "user-1")).toBeNull()
    }
  })

  it("preserves a null state rather than inventing one", () => {
    const blob = signAuthorizationRequest({ ...REQUEST, state: null }, "user-1")
    expect(verifyAuthorizationRequest(blob, "user-1")?.state).toBeNull()
  })
})

describe("scopeCovers", () => {
  it("requires every requested scope to be present", () => {
    expect(scopeCovers("mcp:read mcp:write", ["mcp:read"])).toBe(true)
    expect(scopeCovers("mcp:read", ["mcp:read", "mcp:write"])).toBe(false)
    expect(scopeCovers("", ["mcp:read"])).toBe(false)
    expect(scopeCovers("mcp:read", [])).toBe(true)
  })
})

describe("stored consent", () => {
  it("skips the screen for an already-approved client", async () => {
    await recordConsent("user-1", "client-a", "mcp:read mcp:write")
    expect(await findStoredConsent("user-1", "client-a", ["mcp:read"])).not.toBeNull()
  })

  it("does not skip when the request widens past the stored approval", async () => {
    await recordConsent("user-1", "client-a", "mcp:read")
    expect(await findStoredConsent("user-1", "client-a", ["mcp:read", "mcp:write"])).toBeNull()
  })

  it("overwrites rather than accumulating rows for the same pair", async () => {
    await recordConsent("user-1", "client-a", "mcp:read")
    await recordConsent("user-1", "client-a", "mcp:read mcp:write")
    expect(store.oAuthConsent.rows).toHaveLength(1)
    expect(await findStoredConsent("user-1", "client-a", ["mcp:write"])).not.toBeNull()
  })

  it("is null for a client that was never approved", async () => {
    expect(await findStoredConsent("user-1", "client-never", ["mcp:read"])).toBeNull()
  })

  // The binding is the whole reason this returns a row rather than a boolean.
  // A reconnect has to replay the identity the user chose; replaying only "yes,
  // approved" would silently re-mint a user-mode token for an agent-bound
  // connection, which is the exact privilege increase ADR 0015 exists to close.
  it("defaults to USER mode when no binding is supplied", async () => {
    await recordConsent("user-1", "client-a", "mcp:read")
    expect(await findStoredConsent("user-1", "client-a", ["mcp:read"])).toEqual({
      authorizationMode: "USER",
      agentId: null,
    })
  })

  it("remembers an agent binding so a reconnect replays it", async () => {
    await recordConsent("user-1", "client-a", "mcp:read", {
      authorizationMode: "AGENT",
      agentId: "agent-7",
    })
    expect(await findStoredConsent("user-1", "client-a", ["mcp:read"])).toEqual({
      authorizationMode: "AGENT",
      agentId: "agent-7",
    })
  })

  it("replaces an agent binding with the override when the same client is re-approved", async () => {
    await recordConsent("user-1", "client-a", "mcp:read", {
      authorizationMode: "AGENT",
      agentId: "agent-7",
    })
    await recordConsent("user-1", "client-a", "mcp:read", {
      authorizationMode: "USER",
      agentId: null,
    })
    expect(store.oAuthConsent.rows).toHaveLength(1)
    expect(await findStoredConsent("user-1", "client-a", ["mcp:read"])).toEqual({
      authorizationMode: "USER",
      agentId: null,
    })
  })
})

describe("grantedAccess — what the consent screen must enumerate", () => {
  async function seed() {
    await store.workspaceMember.create({
      data: {
        userId: "user-1",
        workspace: {
          id: "ws-2",
          name: "Zebra",
          slug: "zebra",
          organization: { id: "org-1", name: "Acme", slug: "acme" },
        },
      },
    })
    await store.workspaceMember.create({
      data: {
        userId: "user-1",
        workspace: {
          id: "ws-1",
          name: "Alpha",
          slug: "alpha",
          organization: { id: "org-1", name: "Acme", slug: "acme" },
        },
      },
    })
    await store.workspaceMember.create({
      data: {
        userId: "user-1",
        workspace: {
          id: "ws-3",
          name: "Side project",
          slug: "side",
          organization: { id: "org-2", name: "Beta Corp", slug: "beta" },
        },
      },
    })
    await store.organizationMember.create({
      data: { userId: "user-1", organization: { id: "org-1", name: "Acme", slug: "acme" } },
    })
  }

  it("spans every organization, not just one", async () => {
    // Decision 1 removed the workspace picker, so the grant crosses org
    // boundaries — which is broader than "connect Compass" sounds. Naming them
    // is the compensating control that decision was made in exchange for.
    await seed()
    const { organizations } = await grantedAccess("user-1")

    expect(organizations.map((org) => org.name)).toEqual(["Acme", "Beta Corp"])
    expect(organizations[0].workspaces.map((ws) => ws.name)).toEqual(["Alpha", "Zebra"])
    expect(organizations[1].workspaces.map((ws) => ws.name)).toEqual(["Side project"])
  })

  it("lists an organization the user belongs to even with no workspace there", async () => {
    // Org-level MCP tools resolve against OrganizationMember, so omitting these
    // would understate the grant.
    await store.organizationMember.create({
      data: { userId: "user-1", organization: { id: "org-9", name: "Empty Co", slug: "empty" } },
    })
    const { organizations } = await grantedAccess("user-1")
    expect(organizations).toHaveLength(1)
    expect(organizations[0].organizationMember).toBe(true)
    expect(organizations[0].workspaces).toEqual([])
  })

  it("includes a workspace in an org the user is not an org member of", async () => {
    await store.workspaceMember.create({
      data: {
        userId: "user-1",
        workspace: {
          id: "ws-7",
          name: "Guest",
          slug: "guest",
          organization: { id: "org-7", name: "Host Co", slug: "host" },
        },
      },
    })
    const { organizations } = await grantedAccess("user-1")
    expect(organizations[0].organizationMember).toBe(false)
    expect(organizations[0].workspaces.map((ws) => ws.name)).toEqual(["Guest"])
  })

  it("returns nothing for a user with no memberships", async () => {
    expect(await grantedAccess("user-nobody")).toEqual({
      organizations: [],
      unresolvedMemberships: 0,
    })
  })

  it("does not leak another user's memberships", async () => {
    await seed()
    expect(await grantedAccess("user-2")).toEqual({
      organizations: [],
      unresolvedMemberships: 0,
    })
  })
})

/**
 * Regression cover for the crash QA reproduced against the live consent screen:
 *
 *     TypeError: Cannot read properties of null (reading 'organization')
 *         at grantedOrganizations (lib/oauth/consent.ts:304:22)
 *         at async AuthorizePage (app/oauth/authorize/page.tsx:128:25)
 *
 * This is not a local-only artifact. `relationMode = "prisma"` means the
 * database enforces no foreign keys and performs no cascade deletes, so an
 * ordinary workspace deletion leaves membership rows behind that resolve to
 * `null`. One such row took the entire authorize endpoint down — the user could
 * not consent at all.
 */
describe("grantedAccess — a membership that resolves to nothing", () => {
  beforeEach(() => {
    // The skip is a handled data-integrity defect, and it logs. Silence the
    // warning so an expected condition does not look like test noise, while
    // still exercising the branch that emits it.
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it("degrades instead of throwing when a workspace no longer resolves", async () => {
    // Exactly the shape from the trace: the row exists, the workspace does not.
    await store.workspaceMember.create({ data: { userId: "user-1", workspace: null } })

    await expect(grantedAccess("user-1")).resolves.toEqual({
      organizations: [],
      unresolvedMemberships: 1,
    })
  })

  it("still lists every membership that does resolve", async () => {
    await store.workspaceMember.create({ data: { userId: "user-1", workspace: null } })
    await store.workspaceMember.create({
      data: {
        userId: "user-1",
        workspace: {
          id: "ws-1",
          name: "Alpha",
          slug: "alpha",
          organization: { id: "org-1", name: "Acme", slug: "acme" },
        },
      },
    })

    const { organizations, unresolvedMemberships } = await grantedAccess("user-1")
    expect(organizations.map((org) => org.name)).toEqual(["Acme"])
    expect(organizations[0].workspaces.map((ws) => ws.name)).toEqual(["Alpha"])
    // Reported, not swallowed: the enumeration is the compensating control for
    // there being no workspace picker, so the screen has to be able to say the
    // list is short rather than present it as exhaustive.
    expect(unresolvedMemberships).toBe(1)
  })

  it("survives a workspace whose organization is the part that is missing", async () => {
    // The second orphan shape: the workspace row outlived its organization.
    await store.workspaceMember.create({
      data: {
        userId: "user-1",
        workspace: { id: "ws-2", name: "Stray", slug: "stray", organization: null },
      },
    })

    await expect(grantedAccess("user-1")).resolves.toEqual({
      organizations: [],
      unresolvedMemberships: 1,
    })
  })

  it("survives an organization membership that no longer resolves", async () => {
    await store.organizationMember.create({ data: { userId: "user-1", organization: null } })

    await expect(grantedAccess("user-1")).resolves.toEqual({
      organizations: [],
      unresolvedMemberships: 1,
    })
  })

  it("never over-reports — an unresolvable row is counted, never invented", async () => {
    for (let i = 0; i < 3; i += 1) {
      await store.workspaceMember.create({ data: { userId: "user-1", workspace: null } })
    }

    const { organizations, unresolvedMemberships } = await grantedAccess("user-1")
    expect(organizations).toEqual([])
    expect(unresolvedMemberships).toBe(3)
  })
})
