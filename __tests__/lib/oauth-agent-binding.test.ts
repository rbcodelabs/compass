/**
 * The `credentialId` regression test for ADR 0015.
 *
 * ## Why this file exists separately from mcp-auth.test.ts
 *
 * `validateOAuthAccessToken` returning a `credentialId` looks like a cosmetic
 * field until you follow it. `withAgentActivity` (lib/agent-activity.ts:7)
 * opens with:
 *
 * ```ts
 * if (!actor.agentId || !actor.userId || !actor.credentialId) throw new McpAuthzError("Incomplete agent identity.")
 * ```
 *
 * and that guard fires **only** for `purpose === "AGENT"` **and**
 * `mutation === true`. So an agent-bound token that omits `credentialId`
 * produces a connection where every read succeeds and every write fails — a
 * half-working credential that presents as a Compass bug rather than as a
 * missing field, and which no unit test of `validateOAuthAccessToken` alone
 * would catch.
 *
 * The test therefore walks the **real seam**: bearer header →
 * `validateMcpAuth` → the actor `app/api/mcp/route.ts` builds from its result →
 * `withAgentActivity` with `mutation: true`. Asserting `credentialId` on the
 * auth result would pass with a hard-coded literal; this fails unless the value
 * is genuinely carried the whole way.
 *
 * Deleting `credentialId: accessToken.id` from the OAuth AGENT branch in
 * lib/mcp-auth.ts makes "a mutation through an agent-bound OAuth token
 * succeeds" fail with McpAuthzError("Incomplete agent identity."), while the
 * read case in the same file keeps passing — which is exactly the asymmetry the
 * design warns about.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const agent = { findFirst: vi.fn() }
const oAuthToken = { findFirst: vi.fn(), update: vi.fn() }
const agentToolCall = { create: vi.fn(), update: vi.fn() }
const apiKey = { findFirst: vi.fn(), update: vi.fn() }
const agentWorkspaceGrant = { findMany: vi.fn() }
const workspace = { findFirst: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ agent, oAuthToken, agentToolCall, apiKey, agentWorkspaceGrant, workspace }) }))

import { agentWorkspaceWhere } from "@/lib/agent-access"
import { withAgentActivity } from "@/lib/agent-activity"
import { validateMcpAuth, type McpAuthResult } from "@/lib/mcp-auth"
import { assertOrgAdminBySlug, assertWorkspaceAdmin, type McpActor } from "@/lib/mcp-authz"
import { applyToolGate } from "@/lib/mcp-tool-gates"
import { ok } from "@/lib/mcp-output"

const OAUTH_TOKEN = `cmp_oat_${"b".repeat(32)}`

const TOKEN_ROW = {
  id: "oauth-token-row-id",
  userId: "user-1",
  scope: "mcp:read mcp:write",
  scopeWorkspaceId: null,
  authorizationMode: "AGENT",
  agentId: "agent-1",
}

function bearer() {
  return new Request("https://compass.test/api/mcp", {
    headers: { authorization: `Bearer ${OAUTH_TOKEN}` },
  })
}

/**
 * Exactly the actor `app/api/mcp/route.ts` builds — field for field, so a field
 * dropped there would surface here. Copied rather than imported because the
 * route module pulls in the whole MCP tool catalog.
 */
function actorFromAuth(auth: McpAuthResult): McpActor {
  if (!auth.valid) throw new Error("expected a valid auth result")
  return {
    userId: auth.userId,
    purpose: auth.purpose,
    agentId: auth.agentId,
    credentialId: auth.credentialId,
    credentialType: auth.credentialType,
    scopeWorkspaceId: auth.scopeWorkspaceId,
    scopeConversationId: auth.scopeConversationId,
    scopeClaimId: auth.scopeClaimId,
  }
}

describe("a mutation through an agent-bound OAuth token", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    oAuthToken.findFirst.mockResolvedValue(TOKEN_ROW)
    oAuthToken.update.mockResolvedValue({})
    agent.findFirst.mockResolvedValue({ id: "agent-1" })
    agentToolCall.create.mockResolvedValue({ id: "call-1" })
    agentToolCall.update.mockResolvedValue({})
  })

  it("succeeds, and records an audit row naming the OAuth token as the credential", async () => {
    const actor = actorFromAuth(await validateMcpAuth(bearer()))
    const operation = vi.fn(async () => ok("Created", { id: "task-1" }))

    await expect(
      withAgentActivity(actor, "create_task", true, async () => {}, operation),
    ).resolves.toMatchObject({ structuredContent: { ok: true } })

    expect(operation).toHaveBeenCalledTimes(1)
    expect(agentToolCall.create).toHaveBeenCalledWith({
      data: {
        agentId: "agent-1",
        userId: "user-1",
        // The OAuthToken row id, not an ApiKey id — which is precisely why the
        // discriminator below is not optional.
        credentialId: "oauth-token-row-id",
        credentialType: "OAUTH",
        toolName: "create_task",
        status: "STARTED",
      },
      select: { id: true },
    })
    expect(agentToolCall.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCEEDED" }) }),
    )
  })

  it("reads succeed either way, which is why the write case above is the real test", async () => {
    // Pinning the asymmetry the design calls out: `withAgentActivity` short-
    // circuits for mutation === false before it ever looks at credentialId. A
    // suite that only exercised reads would stay green through the bug.
    const withoutCredential: McpActor = { ...actorFromAuth(await validateMcpAuth(bearer())), credentialId: undefined }
    const operation = vi.fn(async () => ok("Listed", { items: [] }))

    await expect(
      withAgentActivity(withoutCredential, "list_tasks", false, async () => {}, operation),
    ).resolves.toMatchObject({ structuredContent: { ok: true } })
    expect(agentToolCall.create).not.toHaveBeenCalled()

    // …and the same actor, mutating, is refused.
    await expect(
      withAgentActivity(withoutCredential, "create_task", true, async () => {}, operation),
    ).rejects.toThrow("Incomplete agent identity.")
  })

  it("records a DENIED audit row when the tool gate refuses, before running anything", async () => {
    const actor = actorFromAuth(await validateMcpAuth(bearer()))
    const operation = vi.fn()

    await expect(
      withAgentActivity(
        actor,
        "create_workspace",
        true,
        async () => {
          throw new Error("Tool requires a human identity.")
        },
        operation,
      ),
    ).rejects.toThrow("Tool requires a human identity.")

    expect(operation).not.toHaveBeenCalled()
    expect(agentToolCall.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DENIED" }) }),
    )
  })

  it("labels an API-key-derived mutation API_KEY, so the two credential kinds stay distinguishable", async () => {
    apiKey.findFirst.mockResolvedValue({
      id: "api-key-row-id",
      userId: "user-1",
      purpose: "AGENT",
      agentId: "agent-1",
      expiresAt: null,
    })
    apiKey.update.mockResolvedValue({})
    const keyRequest = new Request("https://compass.test/api/mcp", {
      headers: { authorization: `Bearer cmp_${"a".repeat(32)}` },
    })

    const actor = actorFromAuth(await validateMcpAuth(keyRequest))
    await withAgentActivity(actor, "create_task", true, async () => {}, async () => ok("Created", {}))

    expect(agentToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ credentialId: "api-key-row-id", credentialType: "API_KEY" }),
      }),
    )
  })
})

/**
 * The load-bearing claim of ADR 0014, re-checked under ADR 0015: **an OAuth
 * token is just another way to produce an `McpActor`**, so binding one to an
 * agent engages the entire agent authorization model with no change to the
 * authorization logic itself.
 *
 * Traced from the code it looks obviously true. It is asserted here anyway,
 * because "obviously true" is how the seven-versus-six workspace gap got
 * shipped in the first place. Each test below drives a *real* authorization
 * function with an actor produced by `validateMcpAuth` from a real bearer
 * header — nothing is hand-constructed.
 */
describe("an agent-bound OAuth token engages the agent authorization model", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    oAuthToken.findFirst.mockResolvedValue(TOKEN_ROW)
    oAuthToken.update.mockResolvedValue({})
    agent.findFirst.mockResolvedValue({ id: "agent-1" })
  })

  it("narrows workspace reach to unrevoked grants, not to every membership", async () => {
    // The acceptance test for the whole ADR. Before the binding, this actor was
    // purpose USER and agentWorkspaceWhere returned every workspace the user
    // belonged to — the 7-versus-6 delta measured on production.
    agentWorkspaceGrant.findMany.mockResolvedValue([{ workspaceId: "granted-1" }])
    const actor = actorFromAuth(await validateMcpAuth(bearer()))

    expect(await agentWorkspaceWhere(actor)).toEqual({
      members: { some: { userId: "user-1" } },
      id: { in: ["granted-1"] },
    })
    expect(agentWorkspaceGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ agentId: "agent-1", revokedAt: null }) }),
    )
  })

  it("demands a WRITE grant for a mutating tool", async () => {
    agentWorkspaceGrant.findMany.mockResolvedValue([{ workspaceId: "granted-1" }])
    workspace.findFirst.mockResolvedValue({ id: "granted-1" })
    const actor = actorFromAuth(await validateMcpAuth(bearer()))

    await applyToolGate("create_task", actor, { workspaceId: "granted-1" })
    expect(agentWorkspaceGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ access: "WRITE" }) }),
    )
  })

  it.each(["create_workspace", "approve_solution_plan", "request_release_authorization"])(
    "is refused by the AGENT_TOOL_POLICY DENY entry for %s",
    async (tool) => {
      const actor = actorFromAuth(await validateMcpAuth(bearer()))
      await expect(applyToolGate(tool, actor, {})).rejects.toThrow(/human identity/)
    },
  )

  it("is refused by the workspace and org admin assertions", async () => {
    const actor = actorFromAuth(await validateMcpAuth(bearer()))
    await expect(assertWorkspaceAdmin(actor, "granted-1")).rejects.toThrow("Human administrator required.")
    await expect(assertOrgAdminBySlug(actor, "rbcodelabs")).rejects.toThrow("Human administrator required.")
  })

  it("is refused entirely, rather than narrowed, once its agent is suspended", async () => {
    // agentWorkspaceWhere would independently return an empty reach, but the
    // stronger property is that the request never gets that far: validation
    // fails first, so the client sees a 401 and re-authorizes.
    agent.findFirst.mockResolvedValue(null)
    await expect(validateMcpAuth(bearer())).resolves.toEqual({ valid: false })
  })
})
