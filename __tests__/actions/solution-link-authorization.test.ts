/**
 * Tenant isolation for the Solution <-> Key Result picker's server actions (Phase 4B), against the shared
 * two-tenant fake. Pins down what a client can and cannot do with a public POST endpoint: a foreign, missing,
 * NULL-workspace or non-member call writes nothing and returns one identical message, and a forged workspace id
 * is never used.
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
  linkSolutionToKeyResultAction,
  unlinkSolutionFromKeyResultAction,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/solution-link-actions"

const DENIED = { ok: false, error: "Entity not found or access denied" }
const BASE = `/${WS_A.org}/${WS_A.slug}`
const SCREENS = [`${BASE}/discovery/opp-a`, `${BASE}/discovery/tree`, `${BASE}/okrs`, `${BASE}/canvas`]
const state = () => fake.current!.state
const links = () => state().solutionKeyResultLinks
const linkWrites = () => state().writes.filter((w) => /Link\./.test(w))

beforeEach(() => {
  fake.current = createTenantFakePrisma()
  session.userId = USERS.alice
  revalidate.mockClear()
})

describe("linkSolutionToKeyResultAction", () => {
  it("links a member's own solution to their own key result, stamping the solution's workspace", async () => {
    const result = await linkSolutionToKeyResultAction("sol-a", "kr-a")
    expect(result).toEqual({ ok: true, changed: true })
    expect(links()).toHaveLength(1)
    expect(links()[0]).toMatchObject({ workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a", source: "UI", createdById: USERS.alice })
    expect(revalidate.mock.calls.map((c) => c[0])).toEqual(SCREENS)
  })

  it("is idempotent", async () => {
    await linkSolutionToKeyResultAction("sol-a", "kr-a")
    expect(await linkSolutionToKeyResultAction("sol-a", "kr-a")).toEqual({ ok: true, changed: false })
    expect(links()).toHaveLength(1)
  })

  it("ignores a forged workspace id smuggled as an extra argument", async () => {
    const forged = linkSolutionToKeyResultAction as unknown as (...args: unknown[]) => Promise<unknown>
    await forged("sol-a", "kr-a", "/x", WS_B.id, { workspaceId: WS_B.id })
    expect(links()).toHaveLength(1)
    expect(links()[0]).toMatchObject({ workspaceId: WS_A.id })
  })

  it.each([
    ["a foreign key result", "sol-a", "kr-b"],
    ["a foreign solution", "sol-b", "kr-a"],
    ["a solution with a NULL workspaceId", "sol-null", "kr-a"],
    ["a key result under an objective with a NULL workspaceId", "sol-a", "kr-null"],
    ["a missing key result", "sol-a", "does-not-exist"],
    ["a missing solution", "does-not-exist", "kr-a"],
  ])("denies %s with no writes and one message", async (_label, solutionId, keyResultId) => {
    const result = await linkSolutionToKeyResultAction(solutionId, keyResultId)
    expect(result).toEqual(DENIED)
    expect(links()).toHaveLength(0)
    expect(linkWrites()).toEqual([])
    expect(revalidate).not.toHaveBeenCalled()
  })

  it("denies a signed-in non-member, a member of only the other workspace, and an anonymous caller", async () => {
    for (const userId of [USERS.eve, USERS.bob, null]) {
      session.userId = userId
      expect(await linkSolutionToKeyResultAction("sol-a", "kr-a")).toEqual(DENIED)
    }
    expect(links()).toHaveLength(0)
    expect(linkWrites()).toEqual([])
  })

  it("a member of A cannot link B's rows even if they know the ids, and bob cannot link A's", async () => {
    expect(await linkSolutionToKeyResultAction("sol-b", "kr-b")).toEqual(DENIED)
    session.userId = USERS.bob
    expect(await linkSolutionToKeyResultAction("sol-a", "kr-b")).toEqual(DENIED)
    expect(await linkSolutionToKeyResultAction("sol-b", "kr-a")).toEqual(DENIED)
    expect(await linkSolutionToKeyResultAction("sol-b", "kr-b")).toEqual({ ok: true, changed: true })
    expect(links().map((l) => l.workspaceId)).toEqual([WS_B.id])
  })

  it("rejects malformed input before any lookup", async () => {
    const bad = linkSolutionToKeyResultAction as unknown as (...args: unknown[]) => Promise<unknown>
    expect(await bad({ id: "sol-a" }, "kr-a")).toEqual({ ok: false, error: "Invalid request" })
    expect(await bad("sol-a", "")).toEqual({ ok: false, error: "Invalid request" })
    expect(await bad("sol-a", "x".repeat(200))).toEqual({ ok: false, error: "Invalid request" })
    expect(links()).toHaveLength(0)
  })

  it("never revalidates a path the client supplies", async () => {
    const forged = linkSolutionToKeyResultAction as unknown as (...args: unknown[]) => Promise<unknown>
    await forged("sol-a", "kr-a", "//evil.example/x")
    await forged("sol-a", "kr-a", "/other-org/other-ws")
    const paths = revalidate.mock.calls.map((c) => c[0] as string)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every((p) => p.startsWith(BASE))).toBe(true)
  })

  it("gives not-found and forbidden the same message (no existence oracle)", async () => {
    const foreign = await linkSolutionToKeyResultAction("sol-a", "kr-b")
    const missing = await linkSolutionToKeyResultAction("sol-a", "nope")
    expect(foreign).toEqual(missing)
  })
})

describe("infrastructure failures are not reported as not-found", () => {
  it("a database error during authorization answers with a generic failure and logs only the name and code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const original = fake.current!.client.solution.findFirst
    fake.current!.client.solution.findFirst = (async () => {
      throw Object.assign(new Error("column solutions.workspace_id SECRET-ROW-DATA does not exist"), { name: "PrismaClientKnownRequestError", code: "P2022" })
    }) as never
    const result = await linkSolutionToKeyResultAction("sol-a", "kr-a")
    fake.current!.client.solution.findFirst = original
    expect(result).toEqual({ ok: false, error: "Something went wrong. Please try again." })
    const text = JSON.stringify(logged.mock.calls)
    expect(text).toContain("P2022")
    expect(text).not.toContain("SECRET-ROW-DATA")
    expect(links()).toHaveLength(0)
    logged.mockRestore()
  })

  it("a missing link table is a generic failure flagged linksUnavailable (not a denial), with nothing written", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const original = fake.current!.client.solutionKeyResultLink.findFirst
    fake.current!.client.solutionKeyResultLink.findFirst = (async () => {
      throw Object.assign(new Error('relation "solution_key_result_links" does not exist'), { name: "PrismaClientKnownRequestError", code: "P2021" })
    }) as never
    const result = await linkSolutionToKeyResultAction("sol-a", "kr-a")
    fake.current!.client.solutionKeyResultLink.findFirst = original
    expect(result).toEqual({ ok: false, error: "Something went wrong. Please try again.", linksUnavailable: true })
    expect(links()).toHaveLength(0)
    logged.mockRestore()
  })

  it("a failure inside the write transaction is generic, and the authorization message stays for real denials", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const original = fake.current!.client.solutionKeyResultLink.findFirst
    fake.current!.client.solutionKeyResultLink.findFirst = (async () => {
      throw Object.assign(new Error("connection terminated"), { name: "Error", code: "ECONNRESET" })
    }) as never
    expect(await linkSolutionToKeyResultAction("sol-a", "kr-a")).toEqual({ ok: false, error: "Something went wrong. Please try again." })
    fake.current!.client.solutionKeyResultLink.findFirst = original
    expect(await linkSolutionToKeyResultAction("sol-a", "kr-b")).toEqual(DENIED)
    expect(JSON.stringify(logged.mock.calls)).toContain("ECONNRESET")
    logged.mockRestore()
  })
})

describe("unlinkSolutionFromKeyResultAction", () => {
  const seedLink = (row: Record<string, unknown> = {}) =>
    links().push({ id: "l-1", workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a", source: "UI", createdById: null, createdAt: new Date(10), ...row })

  it("removes the link", async () => {
    seedLink()
    expect(await unlinkSolutionFromKeyResultAction("sol-a", "kr-a")).toEqual({ ok: true, changed: true })
    expect(links()).toHaveLength(0)
    expect(revalidate.mock.calls.map((c) => c[0])).toEqual(SCREENS)
  })

  it("is a no-op when the pair is not linked", async () => {
    expect(await unlinkSolutionFromKeyResultAction("sol-a", "kr-a")).toEqual({ ok: true, changed: false })
  })

  it.each([
    ["a foreign key result", "sol-a", "kr-b"],
    ["a foreign solution", "sol-b", "kr-a"],
    ["a solution with a NULL workspaceId", "sol-null", "kr-a"],
  ])("denies %s and leaves every link untouched", async (_label, solutionId, keyResultId) => {
    seedLink()
    links().push({ id: "l-b", workspaceId: WS_B.id, solutionId: "sol-b", keyResultId: "kr-b", source: "UI", createdById: null, createdAt: new Date(11) })
    expect(await unlinkSolutionFromKeyResultAction(solutionId, keyResultId)).toEqual(DENIED)
    expect(links()).toHaveLength(2)
    expect(linkWrites()).toEqual([])
  })

  it("denies a non-member and an anonymous caller without deleting", async () => {
    seedLink()
    for (const userId of [USERS.eve, USERS.bob, null]) {
      session.userId = userId
      expect(await unlinkSolutionFromKeyResultAction("sol-a", "kr-a")).toEqual(DENIED)
    }
    expect(links()).toHaveLength(1)
  })
})
