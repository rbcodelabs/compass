/**
 * Unit tests for app/api/account/route.ts (self-service account deletion).
 * Session-gated via auth(); the user id always comes from the session, never the request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => vi.fn())
const findUnique = vi.hoisted(() => vi.fn())
const planAccountDeletion = vi.hoisted(() => vi.fn())
const deleteAccount = vi.hoisted(() => vi.fn())
const cookieStore = vi.hoisted(() => ({
  getAll: vi.fn(),
  delete: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ user: { findUnique } }) }))
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }))
vi.mock("@/lib/account-deletion", async () => {
  class RetryableDeletionError extends Error {}
  return { planAccountDeletion, deleteAccount, RetryableDeletionError }
})

import { DELETE, GET } from "@/app/api/account/route"
import { RetryableDeletionError } from "@/lib/account-deletion"

const PLAN = { blockers: [], soleOwned: { organizations: [], workspaces: [] } }

function del(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  return DELETE(new Request("http://localhost/api/account", { method: "DELETE", headers, body: typeof body === "string" ? body : JSON.stringify(body) }))
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.mockResolvedValue({ user: { id: "user-1" } })
  findUnique.mockResolvedValue({ email: "Me@Example.com" })
  cookieStore.getAll.mockReturnValue([
    { name: "authjs.session-token", value: "x" },
    { name: "__Secure-authjs.session-token.0", value: "x" },
    { name: "authjs.csrf-token", value: "y" },
    { name: "sidebar_state", value: "true" },
  ])
})

describe("GET /api/account", () => {
  it("401s without a session and reads nothing", async () => {
    auth.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
    expect(findUnique).not.toHaveBeenCalled()
  })

  it("returns the email and the deletion plan for the session user only", async () => {
    planAccountDeletion.mockResolvedValue({ ...PLAN, blockers: [{ kind: "WORKSPACE_SOLE_ADMIN" }] })
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ email: "Me@Example.com", blockers: [{ kind: "WORKSPACE_SOLE_ADMIN" }] })
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "user-1" }, select: { email: true } })
    expect(planAccountDeletion).toHaveBeenCalledWith(expect.anything(), "user-1")
  })
})

describe("DELETE /api/account", () => {
  it("401s without a session and deletes nothing", async () => {
    auth.mockResolvedValue(null)
    expect((await del({ confirmEmail: "me@example.com" })).status).toBe(401)
    expect(deleteAccount).not.toHaveBeenCalled()
  })

  it("rejects a non-JSON content type (a cross-site form post cannot set application/json)", async () => {
    const response = await del("confirmEmail=me@example.com", { "content-type": "application/x-www-form-urlencoded" })
    expect(response.status).toBe(415)
    expect(deleteAccount).not.toHaveBeenCalled()
  })

  it("rejects malformed JSON and a missing confirmation", async () => {
    expect((await del("{not json")).status).toBe(400)
    expect((await del({})).status).toBe(400)
    expect((await del({ confirmEmail: 42 })).status).toBe(400)
    expect(deleteAccount).not.toHaveBeenCalled()
  })

  it("requires the typed email to match the account email, ignoring case and surrounding space", async () => {
    const wrong = await del({ confirmEmail: "someone-else@example.com" })
    expect(wrong.status).toBe(400)
    expect(deleteAccount).not.toHaveBeenCalled()

    deleteAccount.mockResolvedValue({ ok: true, revocation: { googleSignInRevoked: 1 } })
    const ok = await del({ confirmEmail: "  me@EXAMPLE.com " })
    expect(ok.status).toBe(200)
    expect(deleteAccount).toHaveBeenCalledWith(expect.anything(), "user-1", { deleteSoleOwned: false })
  })

  it("passes sole-owned consent only when it is exactly true", async () => {
    deleteAccount.mockResolvedValue({ ok: true, revocation: {} })
    await del({ confirmEmail: "me@example.com", deleteSoleOwned: "yes" })
    expect(deleteAccount).toHaveBeenLastCalledWith(expect.anything(), "user-1", { deleteSoleOwned: false })
    await del({ confirmEmail: "me@example.com", deleteSoleOwned: true })
    expect(deleteAccount).toHaveBeenLastCalledWith(expect.anything(), "user-1", { deleteSoleOwned: true })
  })

  it("never lets the request name another user", async () => {
    deleteAccount.mockResolvedValue({ ok: true, revocation: {} })
    await del({ confirmEmail: "me@example.com", userId: "victim", id: "victim" })
    expect(deleteAccount).toHaveBeenCalledWith(expect.anything(), "user-1", expect.anything())
  })

  it("invalidates the session: clears every session-token cookie and nothing else", async () => {
    deleteAccount.mockResolvedValue({ ok: true, revocation: {} })
    const response = await del({ confirmEmail: "me@example.com" })
    expect(await response.json()).toMatchObject({ deleted: true })
    expect(cookieStore.delete.mock.calls.map((c) => c[0])).toEqual(["authjs.session-token", "__Secure-authjs.session-token.0"])
  })

  it("409s with the blockers and clears no cookies when deletion is blocked", async () => {
    deleteAccount.mockResolvedValue({ ok: false, reason: "BLOCKED", plan: { ...PLAN, blockers: [{ kind: "ORGANIZATION_SOLE_OWNER" }] } })
    const response = await del({ confirmEmail: "me@example.com" })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: "BLOCKED", blockers: [{ kind: "ORGANIZATION_SOLE_OWNER" }] })
    expect(cookieStore.delete).not.toHaveBeenCalled()
  })

  it("409s when sole-owned resources need consent", async () => {
    deleteAccount.mockResolvedValue({ ok: false, reason: "SOLE_OWNED_NEEDS_CONFIRMATION", plan: PLAN })
    expect((await del({ confirmEmail: "me@example.com" })).status).toBe(409)
  })

  it("404s when the account no longer exists", async () => {
    findUnique.mockResolvedValue(null)
    expect((await del({ confirmEmail: "me@example.com" })).status).toBe(404)
    expect(deleteAccount).not.toHaveBeenCalled()
  })

  it("500s with a generic message on an unexpected failure, without leaking internals or clearing the session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    deleteAccount.mockRejectedValue(new Error("connection string postgres://secret"))
    const response = await del({ confirmEmail: "me@example.com" })
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain("secret")
    expect(cookieStore.delete).not.toHaveBeenCalled()
  })

  it("surfaces a retryable failure's own message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    deleteAccount.mockRejectedValue(new RetryableDeletionError("Please try again in a few minutes."))
    const response = await del({ confirmEmail: "me@example.com" })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "Please try again in a few minutes." })
  })
})
