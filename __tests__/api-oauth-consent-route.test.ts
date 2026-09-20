/**
 * `POST /oauth/consent` — the approve/deny submission.
 *
 * The behaviours worth pinning are the ones a reviewer would want to see proven
 * rather than asserted in a comment: that only an explicit `allow` issues a
 * code, that a forged or cross-user signature issues nothing, that the redirect
 * URI cannot be swapped between the screen and the submit, and — since ADR
 * 0015 — that **no cookie is written at all**, because the remembered approval
 * now carries a binding and has to stay server-revocable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createOAuthStore } from "./helpers/oauth-store"

const store = createOAuthStore()
vi.mock("@/lib/db", () => ({ default: () => store.prisma }))

const session = vi.hoisted(() => ({ value: { user: { id: "user-1", email: "rick@example.com" } } as unknown }))
vi.mock("@/auth", () => ({ auth: async () => session.value }))

/**
 * The inline-agent writes go through the *Settings* server actions, not a
 * second grant path, so that `resolveWorkspaceAdmin` and the membership-touch
 * concurrency guard apply unchanged. Mocked here so the assertion is "consent
 * called the Settings action with these arguments" rather than a re-test of
 * what those actions already have coverage for.
 */
const actions = vi.hoisted(() => ({
  createAgent: vi.fn<(input: { name: string }) => Promise<{ id: string }>>(async () => ({
    id: "agent-new",
  })),
  grantWorkspaceAgent: vi.fn<
    (
      orgSlug: string,
      workspaceSlug: string,
      agentId: string,
      access: "READ" | "WRITE",
    ) => Promise<void>
  >(async () => {}),
}))
vi.mock("@/app/settings/agents/actions", () => actions)

import { POST } from "@/app/oauth/consent/route"
import { signAuthorizationRequest } from "@/lib/oauth/consent"

const ORIGIN = "https://compass.example.com"
const CLIENT_ID = "cmp_oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const REQUEST = {
  clientId: CLIENT_ID,
  redirectUri: "http://127.0.0.1:54321/callback",
  state: "abc123",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256",
  scope: "mcp:read mcp:write",
  resource: `${ORIGIN}/api/mcp`,
}

function submit(fields: Record<string, string | readonly string[]>, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }
  if (cookie) headers.cookie = cookie
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const item of value) body.append(key, item)
    } else {
      body.set(key, value as string)
    }
  }
  return POST(
    new Request(`${ORIGIN}/oauth/consent`, {
      method: "POST",
      headers,
      body: body.toString(),
    }),
  )
}

async function registerClient(overrides: Record<string, unknown> = {}) {
  await store.oAuthClient.create({
    data: {
      clientId: CLIENT_ID,
      clientName: "Agent Threads",
      redirectUris: ["http://127.0.0.1/callback"],
      grantTypes: ["authorization_code", "refresh_token"],
      scope: "mcp:read mcp:write offline_access",
      tokenEndpointAuthMethod: "none",
      ...overrides,
    },
  })
}

beforeEach(async () => {
  store.reset()
  session.value = { user: { id: "user-1", email: "rick@example.com" } }
  vi.stubEnv("VERCEL_ENV", "")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN)
  vi.stubEnv("AUTH_SECRET", "test-signing-secret-value")
  await registerClient()
})
afterEach(() => vi.unstubAllEnvs())

describe("approval", () => {
  it("issues a code and redirects to the client with state and iss", async () => {
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
    })

    // 303, so the browser follows up with a GET — which is what a loopback
    // callback server is listening for.
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get("location")!)
    expect(location.origin).toBe("http://127.0.0.1:54321")
    expect(location.searchParams.get("code")).toMatch(/^cmp_oac_[0-9a-f]{32}$/)
    expect(location.searchParams.get("state")).toBe("abc123")
    // RFC 9207 — the AS metadata advertises support, so it must be emitted.
    expect(location.searchParams.get("iss")).toBe(ORIGIN)
  })

  it("binds the code to the signed-in user and the signed request", async () => {
    await submit({ decision: "allow", request: signAuthorizationRequest(REQUEST, "user-1") })

    const [code] = store.oAuthAuthorizationCode.rows
    expect(code.userId).toBe("user-1")
    expect(code.clientId).toBe(CLIENT_ID)
    expect(code.redirectUri).toBe(REQUEST.redirectUri)
    expect(code.codeChallenge).toBe(REQUEST.codeChallenge)
    expect(code.resource).toBe(REQUEST.resource)
  })

  it("records the consent so the next authorization can skip the screen", async () => {
    await submit({ decision: "allow", request: signAuthorizationRequest(REQUEST, "user-1") })
    expect(store.oAuthConsent.rows).toHaveLength(1)
    expect(store.oAuthConsent.rows[0]).toMatchObject({
      userId: "user-1",
      clientId: CLIENT_ID,
      scope: "mcp:read mcp:write",
    })
  })

  it("audits an interactive USER authorization without storing request secrets", async () => {
    await submit({ decision: "allow", request: signAuthorizationRequest(REQUEST, "user-1") })

    const [code] = store.oAuthAuthorizationCode.rows
    expect(store.oAuthAuthorizationEvent.rows).toEqual([
      expect.objectContaining({
        eventType: "USER_OVERRIDE_AUTHORIZED",
        source: "INTERACTIVE_CONSENT",
        authorizationCodeId: code.id,
        userId: "user-1",
        clientId: CLIENT_ID,
        clientNameSnapshot: "Agent Threads",
        redirectOrigin: "http://127.0.0.1:54321",
        authorizationMode: "USER",
        agentId: null,
        scope: "mcp:read mcp:write",
      }),
    ])
    const serialized = JSON.stringify(store.oAuthAuthorizationEvent.rows[0])
    expect(serialized).not.toContain(REQUEST.codeChallenge)
    expect(serialized).not.toContain(REQUEST.state)
    expect(serialized).not.toContain("callback")
  })

  it("returns no code or new consent when USER audit persistence fails", async () => {
    store.oAuthAuthorizationEvent.create.mockRejectedValueOnce(new Error("event write failed"))

    await expect(
      submit({ decision: "allow", request: signAuthorizationRequest(REQUEST, "user-1") }),
    ).rejects.toThrow("event write failed")

    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
    expect(store.oAuthAuthorizationEvent.rows).toHaveLength(0)
    expect(store.oAuthConsent.rows).toHaveLength(0)
  })

  // The inverse of the Phase 1 assertion, and it is the one that keeps ADR 0015
  // honest. A 90-day `__Host-` cookie recording an approval is a second source
  // of truth that no server-side migration can revoke, so re-introducing one
  // would let an already-consented browser skip the binding screen — the exact
  // way this whole change becomes a silent no-op for the person it was built
  // for.
  it("writes no consent cookie, because OAuthConsent is the only record", async () => {
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
    })
    expect(response.headers.get("set-cookie")).toBeNull()
  })
})

describe("denial", () => {
  it("redirects back with access_denied and issues nothing", async () => {
    const response = await submit({
      decision: "deny",
      request: signAuthorizationRequest(REQUEST, "user-1"),
    })

    const location = new URL(response.headers.get("location")!)
    expect(location.searchParams.get("error")).toBe("access_denied")
    expect(location.searchParams.get("state")).toBe("abc123")
    expect(location.searchParams.get("iss")).toBe(ORIGIN)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
    expect(store.oAuthConsent.rows).toHaveLength(0)
  })

  it("treats a missing or unexpected decision as a denial", async () => {
    // A missing field must never be read as approval.
    const cases: Record<string, string>[] = [{}, { decision: "" }, { decision: "yes" }, { decision: "ALLOW" }]
    for (const fields of cases) {
      store.reset()
      await registerClient()
      const response = await submit({
        ...fields,
        request: signAuthorizationRequest(REQUEST, "user-1"),
      })
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("access_denied")
      expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
    }
  })

  it("sets no cookie on a denial", async () => {
    const response = await submit({
      decision: "deny",
      request: signAuthorizationRequest(REQUEST, "user-1"),
    })
    expect(response.headers.get("set-cookie")).toBeNull()
  })
})

describe("CSRF and tampering", () => {
  it("rejects a request signed for a different user", async () => {
    // The blob is bound to session.user.id, so a captured one is worthless and
    // a third-party site cannot mint one at all.
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "someone-else"),
    })
    expect(response.status).toBe(400)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })

  it("rejects a missing or forged blob", async () => {
    for (const request of ["", "forged.signature", "not-a-blob"]) {
      const response = await submit({ decision: "allow", request })
      expect(response.status).toBe(400)
    }
    expect((await submit({ decision: "allow" })).status).toBe(400)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })

  it("cannot have its redirect_uri swapped between the screen and the submit", async () => {
    // The canonical attack: the consent screen shows 127.0.0.1, the POST tries
    // to deliver the code somewhere else. There are no unsigned fields to swap.
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      redirect_uri: "https://evil.example.com/callback",
      client_id: "cmp_oc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      scope: "mcp:read mcp:write offline_access",
    })

    const location = new URL(response.headers.get("location")!)
    expect(location.origin).toBe("http://127.0.0.1:54321")
    expect(store.oAuthAuthorizationCode.rows[0].scope).toBe("mcp:read mcp:write")
  })

  it("rejects an expired request", async () => {
    const stale = signAuthorizationRequest(REQUEST, "user-1", new Date(Date.now() - 60 * 60 * 1000))
    expect((await submit({ decision: "allow", request: stale })).status).toBe(400)
  })

  it("401s without a session", async () => {
    const blob = signAuthorizationRequest(REQUEST, "user-1")
    session.value = null
    const response = await submit({ decision: "allow", request: blob })
    expect(response.status).toBe(401)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })
})

describe("re-validation between render and submit", () => {
  it("refuses when the client was deleted after the screen rendered", async () => {
    const blob = signAuthorizationRequest(REQUEST, "user-1")
    store.oAuthClient.rows = []

    const response = await submit({ decision: "allow", request: blob })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_client")
  })

  it("refuses when the redirect URI was de-registered after the screen rendered", async () => {
    const blob = signAuthorizationRequest(REQUEST, "user-1")
    store.oAuthClient.rows[0].redirectUris = ["https://claude.ai/api/mcp/auth_callback"]

    // A signature proves the request was authentic when rendered, not that it
    // is still authorized now.
    const response = await submit({ decision: "allow", request: blob })
    expect(response.status).toBe(400)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })
})

/**
 * ADR 0015 stage 2: the POST is where a binding stops being a radio button and
 * becomes two columns on a row. Everything asserted here is asserted against
 * the *stored code*, because that is what the token exchange reads — a consent
 * screen that renders a perfect picker and writes `authorization_mode = 'USER'`
 * is the exact silent no-op this change exists to avoid.
 */
describe("agent binding", () => {
  beforeEach(() => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    actions.createAgent.mockClear()
    actions.createAgent.mockImplementation(async () => ({ id: "agent-new" }))
    actions.grantWorkspaceAgent.mockClear()
    actions.grantWorkspaceAgent.mockImplementation(async () => {})
  })

  async function seedAdminMembership() {
    await store.workspaceMember.create({
      data: {
        userId: "user-1",
        role: "ADMIN",
        workspace: {
          id: "ws-1",
          name: "Compass",
          slug: "compass",
          organization: { id: "org-1", name: "rbcodelabs", slug: "rbcodelabs", members: [] },
        },
      },
    })
    await store.workspace.create({ data: { id: "ws-1", members: [{ userId: "user-1" }] } })
  }

  async function seedGrantedAgent() {
    await seedAdminMembership()
    await store.agent.create({ data: { id: "agent-1", ownerUserId: "user-1", name: "PM Agent" } })
    await store.agentWorkspaceGrant.create({
      data: { agentId: "agent-1", workspaceId: "ws-1", access: "WRITE" },
    })
  }

  it("writes AGENT mode and the agent id onto the authorization code", async () => {
    await seedGrantedAgent()
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      binding: "agent",
      agentId: "agent-1",
    })
    expect(response.status).toBe(303)
    expect(store.oAuthAuthorizationCode.rows[0]).toMatchObject({
      authorizationMode: "AGENT",
      agentId: "agent-1",
    })
    expect(store.oAuthAuthorizationEvent.rows).toHaveLength(0)
  })

  it("remembers the binding on the consent row so a reconnect replays it", async () => {
    await seedGrantedAgent()
    await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      binding: "agent",
      agentId: "agent-1",
    })
    expect(store.oAuthConsent.rows[0]).toMatchObject({
      authorizationMode: "AGENT",
      agentId: "agent-1",
    })
  })

  it("creates an agent inline through the Settings actions and binds to it", async () => {
    await seedAdminMembership()
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      binding: "new",
      agentName: "Geode PM",
      grantWorkspaceId: "ws-1",
    })
    expect(response.status).toBe(303)
    expect(actions.createAgent).toHaveBeenCalledWith({ name: "Geode PM" })
    expect(actions.grantWorkspaceAgent).toHaveBeenCalledWith(
      "rbcodelabs",
      "compass",
      "agent-new",
      "WRITE",
    )
    expect(store.oAuthAuthorizationCode.rows[0]).toMatchObject({
      authorizationMode: "AGENT",
      agentId: "agent-new",
    })
  })

  it("removes partial grants before rolling back an inline-created agent", async () => {
    await seedAdminMembership()
    await store.workspaceMember.create({
      data: {
        userId: "user-1",
        role: "ADMIN",
        workspace: {
          id: "ws-2",
          name: "Geode",
          slug: "geode",
          organization: { id: "org-1", name: "rbcodelabs", slug: "rbcodelabs", members: [] },
        },
      },
    })
    await store.workspace.create({ data: { id: "ws-2", members: [{ userId: "user-1" }] } })
    actions.createAgent.mockImplementation(async ({ name }: { name: string }) => {
      await store.agent.create({ data: { id: "agent-new", ownerUserId: "user-1", name } })
      return { id: "agent-new" }
    })
    actions.grantWorkspaceAgent.mockImplementation(
      async (_orgSlug: string, workspaceSlug: string, agentId: string, access: "READ" | "WRITE") => {
        if (workspaceSlug === "geode") throw new Error("Membership changed; retry the operation")
        await store.agentWorkspaceGrant.create({
          data: { agentId, workspaceId: "ws-1", access, grantedByUserId: "user-1" },
        })
      },
    )

    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      binding: "new",
      agentName: "Doomed",
      grantWorkspaceId: ["ws-1", "ws-2"],
    })

    expect(response.status).toBe(400)
    expect(store.agent.rows, "the just-created agent must be rolled back").toHaveLength(0)
    expect(store.agentWorkspaceGrant.rows, "successful earlier grants must not be orphaned").toHaveLength(0)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
    expect(store.oAuthConsent.rows).toHaveLength(0)
  })

  it("rolls back an inline-created agent when authorization persistence fails", async () => {
    await seedAdminMembership()
    actions.createAgent.mockImplementation(async ({ name }: { name: string }) => {
      await store.agent.create({ data: { id: "agent-new", ownerUserId: "user-1", name } })
      return { id: "agent-new" }
    })
    actions.grantWorkspaceAgent.mockImplementation(
      async (_orgSlug: string, _workspaceSlug: string, agentId: string, access: "READ" | "WRITE") => {
        await store.agentWorkspaceGrant.create({
          data: { agentId, workspaceId: "ws-1", access, grantedByUserId: "user-1" },
        })
      },
    )
    store.oAuthConsent.upsert.mockRejectedValueOnce(new Error("consent write failed"))

    await expect(
      submit({
        decision: "allow",
        request: signAuthorizationRequest(REQUEST, "user-1"),
        binding: "new",
        agentName: "Doomed",
        grantWorkspaceId: "ws-1",
      }),
    ).rejects.toThrow("consent write failed")

    expect(store.agent.rows, "the just-created agent must be rolled back").toHaveLength(0)
    expect(store.agentWorkspaceGrant.rows, "its grant must be rolled back first").toHaveLength(0)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })

  it("removes the remembered binding when authorization-code persistence fails", async () => {
    await seedAdminMembership()
    actions.createAgent.mockImplementation(async ({ name }: { name: string }) => {
      await store.agent.create({ data: { id: "agent-new", ownerUserId: "user-1", name } })
      return { id: "agent-new" }
    })
    actions.grantWorkspaceAgent.mockImplementation(
      async (_orgSlug: string, _workspaceSlug: string, agentId: string, access: "READ" | "WRITE") => {
        await store.agentWorkspaceGrant.create({
          data: { agentId, workspaceId: "ws-1", access, grantedByUserId: "user-1" },
        })
      },
    )
    store.oAuthAuthorizationCode.create.mockRejectedValueOnce(new Error("code write failed"))

    await expect(
      submit({
        decision: "allow",
        request: signAuthorizationRequest(REQUEST, "user-1"),
        binding: "new",
        agentName: "Doomed",
        grantWorkspaceId: "ws-1",
      }),
    ).rejects.toThrow("code write failed")

    expect(store.agent.rows).toHaveLength(0)
    expect(store.agentWorkspaceGrant.rows).toHaveLength(0)
    expect(store.oAuthConsent.rows, "the incomplete authorization must not be replayable").toHaveLength(0)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })

  it.each([
    ["consent", () => store.oAuthConsent.upsert.mockRejectedValueOnce(new Error("consent write failed"))],
    ["code", () => store.oAuthAuthorizationCode.create.mockRejectedValueOnce(new Error("code write failed"))],
  ])("preserves an existing live connection when %s persistence fails", async (_failure, failWrite) => {
    await seedGrantedAgent()
    const grantedAt = new Date("2026-09-18T10:00:00.000Z")
    await store.oAuthConsent.create({
      data: {
        id: "consent-existing",
        userId: "user-1",
        clientId: CLIENT_ID,
        scope: "mcp:read",
        authorizationMode: "USER",
        agentId: null,
        grantedAt,
      },
    })
    await store.oAuthToken.create({
      data: {
        clientId: CLIENT_ID,
        userId: "user-1",
        tokenHash: "existing-live-token",
        type: "ACCESS",
        scope: "mcp:read",
        resource: REQUEST.resource,
        authorizationMode: "USER",
        agentId: null,
        familyId: "family-existing",
        expiresAt: new Date("2026-09-20T10:00:00.000Z"),
      },
    })
    failWrite()

    await expect(
      submit({
        decision: "allow",
        request: signAuthorizationRequest(REQUEST, "user-1"),
        binding: "agent",
        agentId: "agent-1",
      }),
    ).rejects.toThrow(`${_failure} write failed`)

    expect(store.oAuthConsent.rows).toEqual([
      expect.objectContaining({
        id: "consent-existing",
        scope: "mcp:read",
        authorizationMode: "USER",
        agentId: null,
        grantedAt,
      }),
    ])
    expect(store.oAuthToken.rows[0]).toMatchObject({
      tokenHash: "existing-live-token",
      revokedAt: null,
    })
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })

  it("issues nothing when the chosen agent can reach no workspace", async () => {
    await seedAdminMembership()
    await store.agent.create({ data: { id: "agent-1", ownerUserId: "user-1", name: "Ungranted" } })
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      binding: "agent",
      agentId: "agent-1",
    })
    expect(response.status).toBe(400)
    expect(store.oAuthAuthorizationCode.rows, "a dead credential must not be minted").toHaveLength(0)
  })

  it("issues nothing for an agent belonging to someone else", async () => {
    await seedAdminMembership()
    await store.agent.create({ data: { id: "agent-x", ownerUserId: "user-2", name: "Theirs" } })
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      binding: "agent",
      agentId: "agent-x",
    })
    expect(response.status).toBe(400)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })

  it("issues nothing when a workspace id the user does not administer is submitted", async () => {
    // The grant checkboxes are unsigned, so this is the tampering case that
    // matters: a hand-rolled POST naming a workspace the user is only a member
    // of. It is rejected before the agent is created.
    await store.workspaceMember.create({
      data: {
        userId: "user-1",
        role: "MEMBER",
        workspace: {
          id: "ws-9",
          name: "Someone Else's",
          slug: "theirs",
          organization: { id: "org-2", name: "Other", slug: "other", members: [] },
        },
      },
    })
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      binding: "new",
      agentName: "Sneaky",
      grantWorkspaceId: "ws-9",
    })
    expect(response.status).toBe(400)
    expect(actions.createAgent).not.toHaveBeenCalled()
  })

  it("refuses the override without a matching typed confirmation, then allows it with one", async () => {
    await store.organizationMember.create({
      data: { organizationId: "org-1", userId: "user-1", role: "OWNER" },
    })
    await seedAdminMembership()

    const wrong = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      binding: "user",
      confirmation: "someone@example.com",
    })
    expect(wrong.status).toBe(400)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)

    const right = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      binding: "user",
      confirmation: "rick@example.com",
    })
    expect(right.status).toBe(303)
    expect(store.oAuthAuthorizationCode.rows[0]).toMatchObject({
      authorizationMode: "USER",
      agentId: null,
    })
  })

  it("refuses the override for a user who is a plain member of any organization", async () => {
    await store.organizationMember.create({
      data: { organizationId: "org-1", userId: "user-1", role: "OWNER" },
    })
    await store.organizationMember.create({
      data: { organizationId: "org-2", userId: "user-1", role: "MEMBER" },
    })
    await seedAdminMembership()
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
      binding: "user",
      confirmation: "rick@example.com",
    })
    expect(response.status).toBe(400)
  })

  it("issues nothing when no binding is submitted at all", async () => {
    // A missing field is never read as a choice: "USER" would be the escalation
    // and "AGENT" has no agent id to use.
    await seedGrantedAgent()
    const response = await submit({
      decision: "allow",
      request: signAuthorizationRequest(REQUEST, "user-1"),
    })
    expect(response.status).toBe(400)
    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
  })
})
