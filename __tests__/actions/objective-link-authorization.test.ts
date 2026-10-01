/**
 * Tenant isolation for the Opportunity <-> Objective picker's server actions (Phase 3C),
 * against the shared two-tenant fake. Pins down what a client can and cannot do with a
 * public POST endpoint: a foreign, missing, NULL-workspace or non-member call writes
 * nothing and returns one identical message, and a forged workspace id is never used.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { USERS, WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma"

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }))
const session = vi.hoisted(() => ({ userId: null as string | null }))
const revalidate = vi.hoisted(() => vi.fn())

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }))
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: "T", email: "t@example.com" } } : null),
}))
vi.mock("next/cache", () => ({ revalidatePath: revalidate }))
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}))

import {
  linkOpportunityToObjectiveAction,
  unlinkOpportunityFromObjectiveAction,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/objective-link-actions"

const DENIED = { ok: false, error: "Entity not found or access denied" }
const BASE = `/${WS_A.org}/${WS_A.slug}`
const SCREENS = [`${BASE}/discovery/opp-a`, `${BASE}/discovery/tree`, `${BASE}/okrs`]
const state = () => fake.current!.state
const links = () => state().opportunityObjectiveLinks
const linkWrites = () => state().writes.filter((w) => /Link\./.test(w))

beforeEach(() => {
  fake.current = createTenantFakePrisma()
  session.userId = USERS.alice
  revalidate.mockClear()
  // A second objective in A, and an opportunity-side pointer fixture for the legacy case.
  state().objectives.push({ id: "obj-a2", workspaceId: WS_A.id, cycleId: "cycle-a", title: "A objective 2", status: "ON_TRACK", sortOrder: 1 })
  state().keyResults.push({ id: "kr-a2", objectiveId: "obj-a2", title: "A key result 2", target: 1, current: 0, sortOrder: 0 })
})

describe("linkOpportunityToObjectiveAction", () => {
  it("links a member's own opportunity to their own objective, stamping the opportunity's workspace", async () => {
    const result = await linkOpportunityToObjectiveAction("opp-a", "obj-a")
    expect(result).toEqual({ ok: true, changed: true })
    expect(links()).toHaveLength(1)
    expect(links()[0]).toMatchObject({
      workspaceId: WS_A.id,
      opportunityId: "opp-a",
      objectiveId: "obj-a",
      origin: "DIRECT",
      source: "UI",
      createdById: USERS.alice,
    })
    expect(revalidate.mock.calls.map((c) => c[0])).toEqual(SCREENS)
  })

  it("is idempotent", async () => {
    await linkOpportunityToObjectiveAction("opp-a", "obj-a")
    const again = await linkOpportunityToObjectiveAction("opp-a", "obj-a")
    expect(again).toEqual({ ok: true, changed: false })
    expect(links()).toHaveLength(1)
  })

  it("ignores a forged workspace id smuggled as an extra argument", async () => {
    const forged = linkOpportunityToObjectiveAction as unknown as (...args: unknown[]) => Promise<unknown>
    await forged("opp-a", "obj-a", "/x", WS_B.id, { workspaceId: WS_B.id })
    expect(links()).toHaveLength(1)
    expect(links()[0]).toMatchObject({ workspaceId: WS_A.id })
  })

  it.each([
    ["a foreign objective", "opp-a", "obj-b"],
    ["a foreign opportunity", "opp-b", "obj-a"],
    ["an objective with a NULL workspaceId", "opp-a", "obj-null"],
    ["a missing objective", "opp-a", "does-not-exist"],
    ["a missing opportunity", "does-not-exist", "obj-a"],
  ])("denies %s with no writes and one message", async (_label, opportunityId, objectiveId) => {
    const result = await linkOpportunityToObjectiveAction(opportunityId, objectiveId)
    expect(result).toEqual(DENIED)
    expect(links()).toHaveLength(0)
    expect(linkWrites()).toEqual([])
    expect(revalidate).not.toHaveBeenCalled()
  })

  it("denies a signed-in non-member, a member of only the other workspace, and an anonymous caller", async () => {
    for (const userId of [USERS.eve, USERS.bob, null]) {
      session.userId = userId
      expect(await linkOpportunityToObjectiveAction("opp-a", "obj-a")).toEqual(DENIED)
    }
    expect(links()).toHaveLength(0)
    expect(linkWrites()).toEqual([])
  })

  it("a member of A cannot link B's rows even if they know the ids, and bob cannot link A's", async () => {
    expect(await linkOpportunityToObjectiveAction("opp-b", "obj-b")).toEqual(DENIED)
    session.userId = USERS.bob
    expect(await linkOpportunityToObjectiveAction("opp-a", "obj-b")).toEqual(DENIED)
    // Bob can link inside his own workspace.
    expect(await linkOpportunityToObjectiveAction("opp-b", "obj-b")).toEqual({ ok: true, changed: true })
    expect(links().map((l) => l.workspaceId)).toEqual([WS_B.id])
  })

  it("rejects malformed input before any lookup", async () => {
    const bad = linkOpportunityToObjectiveAction as unknown as (...args: unknown[]) => Promise<unknown>
    expect(await bad({ id: "opp-a" }, "obj-a")).toEqual({ ok: false, error: "Invalid request" })
    expect(await bad("opp-a", "")).toEqual({ ok: false, error: "Invalid request" })
    expect(await bad("opp-a", "x".repeat(200))).toEqual({ ok: false, error: "Invalid request" })
    expect(links()).toHaveLength(0)
  })

  it("never revalidates a path the client supplies: a smuggled third argument is ignored", async () => {
    const forged = linkOpportunityToObjectiveAction as unknown as (...args: unknown[]) => Promise<unknown>
    await forged("opp-a", "obj-a", "//evil.example/x")
    await forged("opp-a", "obj-a", "/other-org/other-ws")
    const paths = revalidate.mock.calls.map((c) => c[0] as string)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every((p) => p.startsWith(BASE))).toBe(true)
  })

  it("gives not-found and forbidden the same message (no existence oracle)", async () => {
    const foreign = await linkOpportunityToObjectiveAction("opp-a", "obj-b")
    const missing = await linkOpportunityToObjectiveAction("opp-a", "nope")
    expect(foreign).toEqual(missing)
  })
})

describe("infrastructure failures are not reported as not-found", () => {
  const failWith = (code: string) => {
    const original = fake.current!.client.opportunity.findFirst
    fake.current!.client.opportunity.findFirst = (async () => {
      throw Object.assign(new Error("column opportunities.workspace_id SECRET-ROW-DATA does not exist"), { name: "PrismaClientKnownRequestError", code })
    }) as never
    return () => { fake.current!.client.opportunity.findFirst = original }
  }

  it("a database error during authorization answers with a generic failure and logs only the name and code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const restore = failWith("P2022")
    const result = await linkOpportunityToObjectiveAction("opp-a", "obj-a")
    restore()
    expect(result).toEqual({ ok: false, error: "Something went wrong. Please try again." })
    const text = JSON.stringify(logged.mock.calls)
    expect(text).toContain("P2022")
    expect(text).toContain("PrismaClientKnownRequestError")
    expect(text).not.toContain("SECRET-ROW-DATA")
    expect(links()).toHaveLength(0)
    logged.mockRestore()
  })

  it("a failure inside the write transaction is also generic, and the authorization message stays for real denials", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const original = fake.current!.client.opportunityObjectiveLink.findFirst
    fake.current!.client.opportunityObjectiveLink.findFirst = (async () => {
      throw Object.assign(new Error("connection terminated"), { name: "Error", code: "ECONNRESET" })
    }) as never
    expect(await linkOpportunityToObjectiveAction("opp-a", "obj-a")).toEqual({ ok: false, error: "Something went wrong. Please try again." })
    fake.current!.client.opportunityObjectiveLink.findFirst = original
    expect(await linkOpportunityToObjectiveAction("opp-a", "obj-b")).toEqual(DENIED)
    expect(JSON.stringify(logged.mock.calls)).toContain("ECONNRESET")
    logged.mockRestore()
  })
})

describe("a missing link table (migration 071 not applied) fails the write with the generic message", () => {
  it("link and unlink both answer generically and log only the name and code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const original = fake.current!.client.opportunityObjectiveLink.findFirst
    fake.current!.client.opportunityObjectiveLink.findFirst = (async () => {
      throw Object.assign(new Error("relation \"opportunity_objective_links\" does not exist ROW-DATA"), { name: "PrismaClientKnownRequestError", code: "P2021" })
    }) as never
    expect(await linkOpportunityToObjectiveAction("opp-a", "obj-a")).toEqual({ ok: false, error: "Something went wrong. Please try again." })
    expect(await unlinkOpportunityFromObjectiveAction("opp-a", "obj-a")).toEqual({ ok: false, error: "Something went wrong. Please try again." })
    fake.current!.client.opportunityObjectiveLink.findFirst = original
    const text = JSON.stringify(logged.mock.calls)
    expect(text).toContain("P2021")
    expect(text).not.toContain("ROW-DATA")
    expect(links()).toHaveLength(0)
    logged.mockRestore()
  })
})

describe("unlinkOpportunityFromObjectiveAction", () => {
  const seedLink = (row: Record<string, unknown> = {}) =>
    links().push({ id: "l-1", workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT", source: "UI", createdById: null, createdAt: new Date(10), ...row })

  it("removes a DIRECT link", async () => {
    seedLink()
    expect(await unlinkOpportunityFromObjectiveAction("opp-a", "obj-a")).toEqual({ ok: true, changed: true })
    expect(links()).toHaveLength(0)
    expect(revalidate.mock.calls.map((c) => c[0])).toEqual(SCREENS.map((p) => p.replace("opp-a", "opp-a")))
  })

  it("is a no-op when the pair is not linked", async () => {
    expect(await unlinkOpportunityFromObjectiveAction("opp-a", "obj-a")).toEqual({ ok: true, changed: false })
  })

  it("keeps the link and says so while the legacy key result pointer still leads to the objective", async () => {
    state().opportunities[0].linkedKeyResultId = "kr-a"
    seedLink({ origin: "LEGACY" })
    expect(await unlinkOpportunityFromObjectiveAction("opp-a", "obj-a")).toEqual({ ok: true, changed: false, stillLinkedViaKeyResult: true })
    expect(links()).toHaveLength(1)
  })

  it.each([
    ["a foreign objective", "opp-a", "obj-b"],
    ["a foreign opportunity", "opp-b", "obj-a"],
    ["an objective with a NULL workspaceId", "opp-a", "obj-null"],
  ])("denies %s and leaves every link untouched", async (_label, opportunityId, objectiveId) => {
    seedLink()
    links().push({ id: "l-b", workspaceId: WS_B.id, opportunityId: "opp-b", objectiveId: "obj-b", origin: "DIRECT", source: "UI", createdById: null, createdAt: new Date(11) })
    expect(await unlinkOpportunityFromObjectiveAction(opportunityId, objectiveId)).toEqual(DENIED)
    expect(links()).toHaveLength(2)
    expect(linkWrites()).toEqual([])
  })

  it("denies a non-member and an anonymous caller without deleting", async () => {
    seedLink()
    for (const userId of [USERS.eve, USERS.bob, null]) {
      session.userId = userId
      expect(await unlinkOpportunityFromObjectiveAction("opp-a", "obj-a")).toEqual(DENIED)
    }
    expect(links()).toHaveLength(1)
  })
})
