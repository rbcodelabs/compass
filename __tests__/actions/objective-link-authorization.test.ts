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
const PATH = `/${WS_A.org}/${WS_A.slug}/discovery/opp-a`
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
    const result = await linkOpportunityToObjectiveAction("opp-a", "obj-a", PATH)
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
    expect(revalidate).toHaveBeenCalledWith(PATH)
  })

  it("is idempotent", async () => {
    await linkOpportunityToObjectiveAction("opp-a", "obj-a", PATH)
    const again = await linkOpportunityToObjectiveAction("opp-a", "obj-a", PATH)
    expect(again).toEqual({ ok: true, changed: false })
    expect(links()).toHaveLength(1)
  })

  it("ignores a forged workspace id smuggled as an extra argument", async () => {
    const forged = linkOpportunityToObjectiveAction as unknown as (...args: unknown[]) => Promise<unknown>
    await forged("opp-a", "obj-a", PATH, WS_B.id, { workspaceId: WS_B.id })
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
    const result = await linkOpportunityToObjectiveAction(opportunityId, objectiveId, PATH)
    expect(result).toEqual(DENIED)
    expect(links()).toHaveLength(0)
    expect(linkWrites()).toEqual([])
    expect(revalidate).not.toHaveBeenCalled()
  })

  it("denies a signed-in non-member, a member of only the other workspace, and an anonymous caller", async () => {
    for (const userId of [USERS.eve, USERS.bob, null]) {
      session.userId = userId
      expect(await linkOpportunityToObjectiveAction("opp-a", "obj-a", PATH)).toEqual(DENIED)
    }
    expect(links()).toHaveLength(0)
    expect(linkWrites()).toEqual([])
  })

  it("a member of A cannot link B's rows even if they know the ids, and bob cannot link A's", async () => {
    expect(await linkOpportunityToObjectiveAction("opp-b", "obj-b", PATH)).toEqual(DENIED)
    session.userId = USERS.bob
    expect(await linkOpportunityToObjectiveAction("opp-a", "obj-b", PATH)).toEqual(DENIED)
    // Bob can link inside his own workspace.
    expect(await linkOpportunityToObjectiveAction("opp-b", "obj-b", `/${WS_B.org}/${WS_B.slug}/discovery`)).toEqual({ ok: true, changed: true })
    expect(links().map((l) => l.workspaceId)).toEqual([WS_B.id])
  })

  it("rejects malformed input before any lookup", async () => {
    const bad = linkOpportunityToObjectiveAction as unknown as (...args: unknown[]) => Promise<unknown>
    expect(await bad({ id: "opp-a" }, "obj-a", PATH)).toEqual({ ok: false, error: "Invalid request" })
    expect(await bad("opp-a", "", PATH)).toEqual({ ok: false, error: "Invalid request" })
    expect(await bad("opp-a", "x".repeat(200), PATH)).toEqual({ ok: false, error: "Invalid request" })
    expect(links()).toHaveLength(0)
  })

  it("does not revalidate a non-local path", async () => {
    await linkOpportunityToObjectiveAction("opp-a", "obj-a", "//evil.example/x")
    await linkOpportunityToObjectiveAction("opp-a", "obj-a", "https://evil.example/x")
    expect(revalidate).not.toHaveBeenCalled()
  })

  it("gives not-found and forbidden the same message (no existence oracle)", async () => {
    const foreign = await linkOpportunityToObjectiveAction("opp-a", "obj-b", PATH)
    const missing = await linkOpportunityToObjectiveAction("opp-a", "nope", PATH)
    expect(foreign).toEqual(missing)
  })
})

describe("unlinkOpportunityFromObjectiveAction", () => {
  const seedLink = (row: Record<string, unknown> = {}) =>
    links().push({ id: "l-1", workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT", source: "UI", createdById: null, createdAt: new Date(10), ...row })

  it("removes a DIRECT link", async () => {
    seedLink()
    expect(await unlinkOpportunityFromObjectiveAction("opp-a", "obj-a", PATH)).toEqual({ ok: true, changed: true })
    expect(links()).toHaveLength(0)
    expect(revalidate).toHaveBeenCalledWith(PATH)
  })

  it("is a no-op when the pair is not linked", async () => {
    expect(await unlinkOpportunityFromObjectiveAction("opp-a", "obj-a", PATH)).toEqual({ ok: true, changed: false })
  })

  it("keeps the link and says so while the legacy key result pointer still leads to the objective", async () => {
    state().opportunities[0].linkedKeyResultId = "kr-a"
    seedLink({ origin: "LEGACY" })
    expect(await unlinkOpportunityFromObjectiveAction("opp-a", "obj-a", PATH)).toEqual({ ok: true, changed: false, stillLinkedViaKeyResult: true })
    expect(links()).toHaveLength(1)
  })

  it.each([
    ["a foreign objective", "opp-a", "obj-b"],
    ["a foreign opportunity", "opp-b", "obj-a"],
    ["an objective with a NULL workspaceId", "opp-a", "obj-null"],
  ])("denies %s and leaves every link untouched", async (_label, opportunityId, objectiveId) => {
    seedLink()
    links().push({ id: "l-b", workspaceId: WS_B.id, opportunityId: "opp-b", objectiveId: "obj-b", origin: "DIRECT", source: "UI", createdById: null, createdAt: new Date(11) })
    expect(await unlinkOpportunityFromObjectiveAction(opportunityId, objectiveId, PATH)).toEqual(DENIED)
    expect(links()).toHaveLength(2)
    expect(linkWrites()).toEqual([])
  })

  it("denies a non-member and an anonymous caller without deleting", async () => {
    seedLink()
    for (const userId of [USERS.eve, USERS.bob, null]) {
      session.userId = userId
      expect(await unlinkOpportunityFromObjectiveAction("opp-a", "obj-a", PATH)).toEqual(DENIED)
    }
    expect(links()).toHaveLength(1)
  })
})
