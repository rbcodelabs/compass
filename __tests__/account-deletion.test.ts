import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakePrisma, type Row } from "./helpers/fake-prisma"

const cascade = vi.hoisted(() => vi.fn(async () => undefined))
const revokeConnectors = vi.hoisted(() => vi.fn(async () => ({ wiped: 1, providerRevoked: 1, providerNotConfirmed: 0, undecryptable: 0 })))
const blobDel = vi.hoisted(() => vi.fn(async () => undefined))
const callOrder = vi.hoisted(() => ({ events: [] as string[] }))

vi.mock("@/lib/delete-workspace-cascade", () => ({ deleteWorkspaceCascade: cascade }))
vi.mock("@/lib/mcp-connectors/revoke-all", () => ({
  revokeAllConnectorGrants: async (...args: unknown[]) => {
    callOrder.events.push("revoke-connectors")
    return (revokeConnectors as unknown as (...a: unknown[]) => Promise<unknown>)(...args)
  },
}))
vi.mock("@/lib/artifact-storage", () => ({ getAgentSessionStorage: () => ({ del: blobDel, put: vi.fn(), get: vi.fn() }) }))

import { DELETED_USER_LABEL, deleteAccount, planAccountDeletion, RetryableDeletionError } from "@/lib/account-deletion"

const ME = "user-me"
const OTHER = "user-other"
const EMAIL = "me@example.com"

/** Two people sharing one workspace in one org, plus the signed-in user's own data across every table the deletion touches. */
function seed(extra: Record<string, Row[]> = {}) {
  return {
    user: [{ id: ME, email: EMAIL }, { id: OTHER, email: "other@example.com" }],
    organization: [{ id: "org-1", slug: "acme", name: "Acme" }],
    organizationMember: [
      { id: "om-me", organizationId: "org-1", userId: ME, role: "MEMBER" },
      { id: "om-other", organizationId: "org-1", userId: OTHER, role: "OWNER" },
    ],
    workspace: [{ id: "ws-1", slug: "main", name: "Main", organizationId: "org-1" }],
    workspaceMember: [
      { id: "wm-me", workspaceId: "ws-1", userId: ME, role: "MEMBER" },
      { id: "wm-other", workspaceId: "ws-1", userId: OTHER, role: "ADMIN" },
    ],
    account: [{ userId: ME, provider: "google", providerAccountId: "g-1", refresh_token: "refresh-me", access_token: "access-me" }, { userId: OTHER, provider: "google", providerAccountId: "g-2", refresh_token: "refresh-other" }],
    session: [{ id: "s1", userId: ME }, { id: "s2", userId: OTHER }],
    authenticator: [{ id: "a1", userId: ME }],
    verificationToken: [{ identifier: EMAIL, token: "t1" }, { identifier: "other@example.com", token: "t2" }],
    apiKey: [{ id: "k1", userId: ME }, { id: "k2", userId: OTHER }],
    oAuthToken: [{ id: "ot1", userId: ME }, { id: "ot2", userId: OTHER }],
    oAuthConsent: [{ id: "oc1", userId: ME }],
    mcpConnectorGrant: [{ id: "g1", userId: ME }],
    follow: [{ id: "f1", userId: ME }, { id: "f2", userId: OTHER }],
    notification: [{ id: "n1", recipientUserId: ME }, { id: "n2", recipientUserId: OTHER }],
    agent: [{ id: "agent-me", ownerUserId: ME }, { id: "agent-ws", ownerUserId: null }],
    agentWorkspaceGrant: [{ id: "gr1", agentId: "agent-me" }, { id: "gr2", agentId: "agent-ws" }],
    agentConversation: [
      { id: "conv-mine", userId: ME, workspaceId: "ws-1" },
      { id: "conv-theirs", userId: OTHER, workspaceId: "ws-1" },
    ],
    agentMessage: [
      { id: "m1", conversationId: "conv-mine", authorUserId: ME },
      { id: "m2", conversationId: "conv-mine", authorUserId: OTHER },
      { id: "m3", conversationId: "conv-theirs", authorUserId: OTHER },
      { id: "m4", conversationId: "conv-theirs", authorUserId: ME },
    ],
    agentRun: [
      { id: "r1", conversationId: "conv-mine", userId: ME },
      { id: "r2", conversationId: "conv-theirs", userId: OTHER },
      { id: "r3", conversationId: "conv-theirs", userId: ME },
    ],
    agentRunEvent: [{ id: "e1", runId: "r1" }, { id: "e2", runId: "r2" }, { id: "e3", runId: "r3" }],
    agentSession: [{ conversationId: "conv-mine", blobKey: "blob/mine" }, { conversationId: "conv-theirs", blobKey: "blob/theirs" }],
    agentConversationParticipant: [{ id: "p1", conversationId: "conv-theirs", userId: ME }, { id: "p2", conversationId: "conv-mine", userId: OTHER }],
    agentAuditLog: [{ id: "al1", userId: ME, conversationId: "conv-mine" }, { id: "al2", userId: OTHER, conversationId: "conv-theirs" }],
    comment: [
      { id: "c1", authorId: ME, authorType: "HUMAN", authorName: "Me Myself" },
      { id: "c2", authorId: OTHER, authorType: "HUMAN", authorName: "Other Person" },
      { id: "c3", authorId: null, authorType: "AGENT", authorName: "Agent" },
    ],
    docComment: [{ id: "dc1", authorId: ME, authorType: "HUMAN", authorName: "Me Myself" }],
    docVersion: [{ id: "dv1", createdById: ME, createdByName: "Me Myself" }, { id: "dv2", createdById: OTHER, createdByName: "Other Person" }],
    task: [{ id: "t1", assigneeUserId: ME, createdById: ME }, { id: "t2", assigneeUserId: OTHER, createdById: OTHER }],
    doc: [{ id: "d1", createdById: ME }],
    roadmapView: [{ id: "rv1", ownerId: ME, visibility: "PERSONAL" }, { id: "rv2", ownerId: ME, visibility: "WORKSPACE" }],
    ...extra,
  } as Record<string, Row[]>
}

/** An org whose only OWNER/ADMIN-capable person is NOT the other member: nobody but the workspace's own admins can administer it. */
const ORG_WITHOUT_OTHER_ADMINS = [
  { id: "om-me", organizationId: "org-1", userId: ME, role: "MEMBER" },
  { id: "om-other", organizationId: "org-1", userId: OTHER, role: "MEMBER" },
]

const okFetch = () => vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch

beforeEach(() => {
  vi.clearAllMocks()
  callOrder.events = []
})

describe("planAccountDeletion", () => {
  it("has no blockers for an ordinary member of a team that has other owners", async () => {
    const { prisma } = createFakePrisma(seed())
    const plan = await planAccountDeletion(prisma, ME)
    expect(plan.blockers).toEqual([])
    expect(plan.soleOwned).toEqual({ organizations: [] })
  })

  it("blocks when the user is the only owner of an organization other people belong to", async () => {
    const { prisma } = createFakePrisma(seed({
      organizationMember: [
        { id: "om-me", organizationId: "org-1", userId: ME, role: "OWNER" },
        { id: "om-other", organizationId: "org-1", userId: OTHER, role: "MEMBER" },
      ],
    }))
    const plan = await planAccountDeletion(prisma, ME)
    expect(plan.blockers).toEqual([{ kind: "ORGANIZATION_SOLE_OWNER", organization: { slug: "acme", name: "Acme" }, otherMembers: 1 }])
  })

  it("does not block when another owner exists, counting legacy casing as an owner", async () => {
    const { prisma } = createFakePrisma(seed({
      organizationMember: [
        { id: "om-me", organizationId: "org-1", userId: ME, role: "OWNER" },
        { id: "om-other", organizationId: "org-1", userId: OTHER, role: "owner" },
      ],
    }))
    expect((await planAccountDeletion(prisma, ME)).blockers).toEqual([])
  })

  it("blocks when the user is the only workspace administrator and nobody else (workspace admin or org owner/admin) can administer", async () => {
    const { prisma } = createFakePrisma(seed({
      organizationMember: ORG_WITHOUT_OTHER_ADMINS,
      workspaceMember: [
        { id: "wm-me", workspaceId: "ws-1", userId: ME, role: "ADMIN" },
        { id: "wm-other", workspaceId: "ws-1", userId: OTHER, role: "MEMBER" },
      ],
    }))
    const plan = await planAccountDeletion(prisma, ME)
    expect(plan.blockers).toEqual([{ kind: "WORKSPACE_SOLE_ADMIN", workspace: { slug: "main", name: "Main", orgSlug: "acme" }, otherMembers: 1 }])
  })

  it("treats a legacy OWNER role on another workspace member as an administrator", async () => {
    const { prisma } = createFakePrisma(seed({
      organizationMember: ORG_WITHOUT_OTHER_ADMINS,
      workspaceMember: [
        { id: "wm-me", workspaceId: "ws-1", userId: ME, role: "ADMIN" },
        { id: "wm-other", workspaceId: "ws-1", userId: OTHER, role: "OWNER" },
      ],
    }))
    expect((await planAccountDeletion(prisma, ME)).blockers).toEqual([])
  })

  it("lists an organization only the user belongs to as sole-owned, with its workspaces", async () => {
    const { prisma } = createFakePrisma(seed({
      organizationMember: [{ id: "om-me", organizationId: "org-1", userId: ME, role: "OWNER" }],
      workspaceMember: [{ id: "wm-me", workspaceId: "ws-1", userId: ME, role: "ADMIN" }],
    }))
    const plan = await planAccountDeletion(prisma, ME)
    expect(plan.blockers).toEqual([])
    expect(plan.soleOwned.organizations).toEqual([{ id: "org-1", slug: "acme", name: "Acme", workspaceNames: ["Main"] }])
  })

  it("does not call an organization sole-owned while another person is in one of its workspaces", async () => {
    const { prisma } = createFakePrisma(seed({
      organizationMember: [{ id: "om-me", organizationId: "org-1", userId: ME, role: "OWNER" }],
    }))
    const plan = await planAccountDeletion(prisma, ME)
    expect(plan.soleOwned.organizations).toEqual([])
    expect(plan.blockers[0]).toMatchObject({ kind: "ORGANIZATION_SOLE_OWNER", otherMembers: 1 })
  })

  it("never treats a workspace inside a shared organization as sole-owned, even when the user is its only member", async () => {
    const { prisma } = createFakePrisma(seed({ workspaceMember: [{ id: "wm-me", workspaceId: "ws-1", userId: ME, role: "ADMIN" }] }))
    const plan = await planAccountDeletion(prisma, ME)
    expect(plan.soleOwned.organizations).toEqual([])
    // Another org OWNER can still administer it, so nothing blocks either.
    expect(plan.blockers).toEqual([])
  })

  it("two-OWNER organization: the user's only-member workspace is kept for the other OWNER, not deleted, and does not block", async () => {
    const seeded = seed({
      organizationMember: [
        { id: "om-me", organizationId: "org-1", userId: ME, role: "OWNER" },
        { id: "om-other", organizationId: "org-1", userId: OTHER, role: "OWNER" },
      ],
      workspaceMember: [{ id: "wm-me", workspaceId: "ws-1", userId: ME, role: "ADMIN" }],
    })
    const { prisma, rows } = createFakePrisma(seeded)
    const plan = await planAccountDeletion(prisma, ME)
    expect(plan.blockers).toEqual([])
    expect(plan.soleOwned.organizations).toEqual([])
    const result = await deleteAccount(prisma, ME, { fetchImpl: okFetch() })
    expect(result.ok).toBe(true)
    expect(cascade).not.toHaveBeenCalled()
    expect(rows("workspace").map((w) => w.id)).toEqual(["ws-1"])
    expect(rows("organization").map((o) => o.id)).toEqual(["org-1"])
    expect(rows("workspaceMember")).toEqual([])
    expect(rows("organizationMember").map((m) => m.userId)).toEqual([OTHER])
  })

  it("blocks when dropping the user would leave a workspace others can reach with no administrator at all", async () => {
    const { prisma } = createFakePrisma(seed({
      organizationMember: ORG_WITHOUT_OTHER_ADMINS,
      workspaceMember: [{ id: "wm-me", workspaceId: "ws-1", userId: ME, role: "ADMIN" }],
    }))
    const plan = await planAccountDeletion(prisma, ME)
    expect(plan.blockers).toEqual([{ kind: "WORKSPACE_SOLE_ADMIN", workspace: { slug: "main", name: "Main", orgSlug: "acme" }, otherMembers: 1 }])
  })

  it("lets an org ADMIN (not only OWNER) count as the remaining administrator", async () => {
    const { prisma } = createFakePrisma(seed({
      organizationMember: [
        { id: "om-me", organizationId: "org-1", userId: ME, role: "MEMBER" },
        { id: "om-other", organizationId: "org-1", userId: OTHER, role: "ADMIN" },
      ],
      workspaceMember: [{ id: "wm-me", workspaceId: "ws-1", userId: ME, role: "ADMIN" }],
    }))
    expect((await planAccountDeletion(prisma, ME)).blockers).toEqual([])
  })
})

describe("deleteAccount", () => {
  it("returns NOT_FOUND for an account that is already gone (so a retry after success is harmless)", async () => {
    const { prisma } = createFakePrisma(seed({ user: [] }))
    expect(await deleteAccount(prisma, ME, { fetchImpl: okFetch() })).toEqual({ ok: false, reason: "NOT_FOUND" })
  })

  it("refuses while blocked and deletes nothing, not even provider tokens", async () => {
    const fetchImpl = okFetch()
    const { prisma, calls, rows } = createFakePrisma(seed({
      organizationMember: ORG_WITHOUT_OTHER_ADMINS,
      workspaceMember: [
        { id: "wm-me", workspaceId: "ws-1", userId: ME, role: "ADMIN" },
        { id: "wm-other", workspaceId: "ws-1", userId: OTHER, role: "MEMBER" },
      ],
    }))
    const result = await deleteAccount(prisma, ME, { fetchImpl })
    expect(result).toMatchObject({ ok: false, reason: "BLOCKED" })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(revokeConnectors).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.op === "deleteMany" || c.op === "updateMany")).toEqual([])
    expect(rows("user")).toHaveLength(2)
  })

  it("requires explicit consent before deleting sole-owned organizations", async () => {
    const { prisma, rows } = createFakePrisma(seed({
      organizationMember: [{ id: "om-me", organizationId: "org-1", userId: ME, role: "OWNER" }],
      workspaceMember: [{ id: "wm-me", workspaceId: "ws-1", userId: ME, role: "ADMIN" }],
    }))
    const result = await deleteAccount(prisma, ME, { fetchImpl: okFetch() })
    expect(result).toMatchObject({ ok: false, reason: "SOLE_OWNED_NEEDS_CONFIRMATION" })
    expect(cascade).not.toHaveBeenCalled()
    expect(rows("user").some((u) => u.id === ME)).toBe(true)
  })

  it("refuses when what the user confirmed differs from what would be deleted now (stale page or changed membership)", async () => {
    const soloOrg = {
      organizationMember: [{ id: "om-me", organizationId: "org-1", userId: ME, role: "OWNER" }],
      workspaceMember: [{ id: "wm-me", workspaceId: "ws-1", userId: ME, role: "ADMIN" }],
    }
    const stale = createFakePrisma(seed(soloOrg))
    expect(await deleteAccount(stale.prisma, ME, { soleOwnedOrganizationIds: ["some-other-org"], fetchImpl: okFetch() })).toMatchObject({ ok: false, reason: "SOLE_OWNED_CHANGED" })
    expect(await deleteAccount(stale.prisma, ME, { soleOwnedOrganizationIds: ["org-1", "extra"], fetchImpl: okFetch() })).toMatchObject({ ok: false, reason: "SOLE_OWNED_CHANGED" })
    expect(stale.rows("organization")).toHaveLength(1)
    // The org gained a member after the page rendered: the confirmed id is no longer sole-owned.
    const joined = createFakePrisma(seed())
    expect(await deleteAccount(joined.prisma, ME, { soleOwnedOrganizationIds: ["org-1"], fetchImpl: okFetch() })).toMatchObject({ ok: false, reason: "SOLE_OWNED_CHANGED" })
    expect(cascade).not.toHaveBeenCalled()
    expect(joined.rows("user").some((u) => u.id === ME)).toBe(true)
  })

  it("deletes sole-owned organizations (workspaces via the cascade, then org rows) when the caller consents", async () => {
    const { prisma, rows } = createFakePrisma(seed({
      organizationMember: [{ id: "om-me", organizationId: "org-1", userId: ME, role: "OWNER" }],
      workspaceMember: [{ id: "wm-me", workspaceId: "ws-1", userId: ME, role: "ADMIN" }],
      scoringModel: [{ id: "sm1", organizationId: "org-1" }],
    }))
    const result = await deleteAccount(prisma, ME, { soleOwnedOrganizationIds: ["org-1"], fetchImpl: okFetch() })
    expect(result.ok).toBe(true)
    expect(cascade).toHaveBeenCalledTimes(1)
    expect(cascade).toHaveBeenCalledWith(prisma, "ws-1")
    expect(rows("organization")).toEqual([])
    expect(rows("scoringModel")).toEqual([])
  })

  it("removes the user's personal data everywhere and leaves everyone else's untouched", async () => {
    const { prisma, rows } = createFakePrisma(seed())
    const result = await deleteAccount(prisma, ME, { fetchImpl: okFetch() })
    expect(result.ok).toBe(true)

    // Identity and credentials.
    expect(rows("user").map((u) => u.id)).toEqual([OTHER])
    expect(rows("account").map((a) => a.userId)).toEqual([OTHER])
    expect(rows("session").map((s) => s.userId)).toEqual([OTHER])
    expect(rows("authenticator")).toEqual([])
    expect(rows("verificationToken").map((t) => t.identifier)).toEqual(["other@example.com"])
    expect(rows("apiKey").map((k) => k.userId)).toEqual([OTHER])
    expect(rows("oAuthToken").map((t) => t.userId)).toEqual([OTHER])
    expect(rows("oAuthConsent")).toEqual([])
    expect(rows("mcpConnectorGrant")).toEqual([])

    // Memberships and per-user state.
    expect(rows("workspaceMember").map((m) => m.userId)).toEqual([OTHER])
    expect(rows("organizationMember").map((m) => m.userId)).toEqual([OTHER])
    expect(rows("follow").map((f) => f.userId)).toEqual([OTHER])
    expect(rows("notification").map((n) => n.recipientUserId)).toEqual([OTHER])
    expect(rows("roadmapView").map((v) => v.id)).toEqual(["rv2"])

    // Personal agent goes, the workspace agent stays.
    expect(rows("agent").map((a) => a.id)).toEqual(["agent-ws"])
    expect(rows("agentWorkspaceGrant").map((g) => g.id)).toEqual(["gr2"])

    // Agent data: the owned conversation in full; the user's own exchanges inside someone else's conversation.
    expect(rows("agentConversation").map((c) => c.id)).toEqual(["conv-theirs"])
    expect(rows("agentMessage").map((m) => m.id)).toEqual(["m3"])
    expect(rows("agentRun").map((r) => r.id)).toEqual(["r2"])
    expect(rows("agentRunEvent").map((e) => e.id)).toEqual(["e2"])
    expect(rows("agentSession").map((s) => s.conversationId)).toEqual(["conv-theirs"])
    expect(rows("agentConversationParticipant")).toEqual([])
    expect(rows("agentAuditLog").map((a) => a.id)).toEqual(["al2"])
    expect(blobDel).toHaveBeenCalledWith("blob/mine")
    expect(blobDel).not.toHaveBeenCalledWith("blob/theirs")
  })

  it("keeps shared content but anonymizes attribution: names rewritten, assignments cleared, ids left dangling", async () => {
    const { prisma, rows } = createFakePrisma(seed())
    await deleteAccount(prisma, ME, { fetchImpl: okFetch() })
    expect(rows("comment").map((c) => [c.id, c.authorName])).toEqual([["c1", DELETED_USER_LABEL], ["c2", "Other Person"], ["c3", "Agent"]])
    expect(rows("docComment")[0].authorName).toBe(DELETED_USER_LABEL)
    expect(rows("docVersion").map((v) => v.createdByName)).toEqual([DELETED_USER_LABEL, "Other Person"])
    expect(rows("task").map((t) => [t.id, t.assigneeUserId, t.createdById])).toEqual([["t1", null, ME], ["t2", OTHER, OTHER]])
    expect(rows("doc")).toHaveLength(1)
  })

  it("revokes provider access first, while the tokens still exist to be named", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      callOrder.events.push(`fetch:${(init?.body as URLSearchParams).get("token")}`)
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const { prisma, calls } = createFakePrisma(seed())
    const result = await deleteAccount(prisma, ME, { fetchImpl })
    expect(callOrder.events).toEqual(["fetch:refresh-me", "revoke-connectors"])
    expect(fetchImpl).toHaveBeenCalledWith("https://oauth2.googleapis.com/revoke", expect.objectContaining({ method: "POST" }))
    expect(result).toMatchObject({ ok: true, revocation: { googleSignInRevoked: 1, googleSignInNotConfirmed: 0, connectorGrantsWiped: 1, connectorProviderRevoked: 1 } })
    // No delete happened before the revocation reads the account row.
    const firstDelete = calls.findIndex((c) => c.op === "deleteMany")
    const accountRead = calls.findIndex((c) => c.model === "account" && c.op === "findMany")
    expect(accountRead).toBeGreaterThanOrEqual(0)
    expect(accountRead).toBeLessThan(firstDelete)
  })

  it("still deletes everything when Google or the connector provider cannot be reached", async () => {
    revokeConnectors.mockRejectedValueOnce(new Error("provider down"))
    const fetchImpl = vi.fn(async () => { throw new Error("network down") }) as unknown as typeof fetch
    const { prisma, rows } = createFakePrisma(seed())
    const result = await deleteAccount(prisma, ME, { fetchImpl })
    expect(result).toMatchObject({ ok: true, revocation: { googleSignInRevoked: 0, googleSignInNotConfirmed: 1 } })
    expect(rows("user").map((u) => u.id)).toEqual([OTHER])
    expect(rows("account").map((a) => a.userId)).toEqual([OTHER])
  })

  it("deletes sign-in material last and the user row after everything else", async () => {
    const { prisma, calls } = createFakePrisma(seed())
    await deleteAccount(prisma, ME, { fetchImpl: okFetch() })
    const writes = calls.filter((c) => c.op === "deleteMany" || c.op === "updateMany" || c.op === "delete").map((c) => `${c.model}.${c.op}`)
    expect(writes.at(-1)).toBe("user.deleteMany")
    const index = (label: string) => writes.lastIndexOf(label)
    for (const earlier of ["agentMessage.deleteMany", "agentConversation.deleteMany", "workspaceMember.deleteMany", "comment.updateMany", "apiKey.deleteMany"]) {
      expect(index(earlier), earlier).toBeLessThan(index("session.deleteMany"))
    }
    expect(index("session.deleteMany")).toBeLessThan(index("account.deleteMany"))
    expect(index("account.deleteMany")).toBeLessThan(index("user.deleteMany"))
  })

  it("tolerates tables that are not migrated on this deployment", async () => {
    const { prisma, rows } = createFakePrisma(seed(), {
      missingTables: ["follow", "notification", "mcpConnectorGrant", "mcpConnectorAuthRequest", "agentSession", "agentRun", "agentRunEvent", "agentWebSearch", "agentConversationParticipant", "roadmapView", "workspaceUpdatesReadState", "embedVisitorSession", "embedAuthHandoff", "oAuthToken", "oAuthConsent", "oAuthAuthorizationCode", "oAuthAuthorizationEvent"],
    })
    const result = await deleteAccount(prisma, ME, { fetchImpl: okFetch() })
    expect(result.ok).toBe(true)
    expect(rows("user").map((u) => u.id)).toEqual([OTHER])
  })

  it("leaves the account intact and retryable when a step fails part-way", async () => {
    let fail = true
    const { prisma, rows } = createFakePrisma(seed(), {
      failOn: (model, op) => (fail && model === "agentAuditLog" && op === "findMany" ? new Error("db blip") : null),
    })
    await expect(deleteAccount(prisma, ME, { fetchImpl: okFetch() })).rejects.toThrow("db blip")
    // Still signed in, still able to retry: sessions and the user row are only removed at the very end.
    expect(rows("session").some((s) => s.userId === ME)).toBe(true)
    expect(rows("user").some((u) => u.id === ME)).toBe(true)

    fail = false
    const retry = await deleteAccount(prisma, ME, { fetchImpl: okFetch() })
    expect(retry.ok).toBe(true)
    expect(rows("user").map((u) => u.id)).toEqual([OTHER])
  })

  it("refuses to finish while a stored transcript object cannot be deleted, and keeps the pointer for the retry", async () => {
    blobDel.mockRejectedValueOnce(new Error("blob outage"))
    const { prisma, rows } = createFakePrisma(seed())
    await expect(deleteAccount(prisma, ME, { fetchImpl: okFetch() })).rejects.toBeInstanceOf(RetryableDeletionError)
    expect(rows("agentSession").some((s) => s.conversationId === "conv-mine")).toBe(true)
    expect(rows("agentConversation").some((c) => c.id === "conv-mine")).toBe(true)
    expect(rows("user").some((u) => u.id === ME)).toBe(true)

    const retry = await deleteAccount(prisma, ME, { fetchImpl: okFetch() })
    expect(retry.ok).toBe(true)
    expect(rows("agentSession").map((s) => s.conversationId)).toEqual(["conv-theirs"])
  })

  it("deletes in bounded pages, never one statement over the DSQL row ceiling", async () => {
    const manyMessages = Array.from({ length: 1_300 }, (_, i) => ({ id: `bulk-${i}`, conversationId: "conv-theirs", authorUserId: ME }))
    const { prisma, calls } = createFakePrisma(seed({ agentMessage: manyMessages }))
    await deleteAccount(prisma, ME, { fetchImpl: okFetch() })
    const messageDeletes = calls.filter((c) => c.model === "agentMessage" && c.op === "deleteMany" && (c.where as { id?: { in: string[] } })?.id)
    expect(messageDeletes.length).toBeGreaterThanOrEqual(3)
    for (const call of messageDeletes) expect((call.where as { id: { in: string[] } }).id.in.length).toBeLessThanOrEqual(500)
  })

  it("deletes web-search, OAuth and consent rows in bounded pages too", async () => {
    const searches = Array.from({ length: 1_100 }, (_, i) => ({ credentialId: `cred-${i}`, seq: 1, userId: ME, conversationId: null }))
    const tokens = Array.from({ length: 1_100 }, (_, i) => ({ id: `tok-${i}`, userId: ME }))
    const { prisma, calls, rows } = createFakePrisma(seed({ agentWebSearch: searches, oAuthToken: tokens }))
    await deleteAccount(prisma, ME, { fetchImpl: okFetch() })
    expect(rows("agentWebSearch")).toEqual([])
    const searchDeletes = calls.filter((c) => c.model === "agentWebSearch" && c.op === "deleteMany" && (c.where as { OR?: unknown[] })?.OR)
    expect(searchDeletes.length).toBeGreaterThanOrEqual(3)
    for (const call of searchDeletes) expect((call.where as { OR: unknown[] }).OR.length).toBeLessThanOrEqual(500)
    const tokenDeletes = calls.filter((c) => c.model === "oAuthToken" && c.op === "deleteMany" && (c.where as { id?: unknown })?.id)
    expect(tokenDeletes.length).toBeGreaterThanOrEqual(3)
    expect(calls.some((c) => c.model === "oAuthToken" && c.op === "deleteMany" && !(c.where as { id?: unknown })?.id)).toBe(false)
  })
})
