/**
 * Unit tests for app/api/webauthn/authenticators/[id]/route.ts.
 *
 * Session-gated (auth(), not the shared-secret admin checkAuth() pattern):
 * a signed-in user may only revoke their own passkeys. The [id] param is
 * never trusted alone — the delete is always scoped to the requesting
 * user's own id, so another user's authenticator id 404s exactly like a
 * nonexistent one (no existence leak).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => vi.fn())
const findFirst = vi.hoisted(() => vi.fn())
const del = vi.hoisted(() => vi.fn())

vi.mock("@/auth", () => ({ auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ authenticator: { findFirst, delete: del } }) }))

import { DELETE } from "@/app/api/webauthn/authenticators/[id]/route"

function makeRequest(id: string) {
  return DELETE(new Request(`http://localhost/api/webauthn/authenticators/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  })
}

describe("DELETE /api/webauthn/authenticators/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when there is no session", async () => {
    auth.mockResolvedValue(null)

    const response = await makeRequest("authenticator-1")

    expect(response.status).toBe(401)
    expect(findFirst).not.toHaveBeenCalled()
  })

  it("returns 404 when the authenticator does not belong to the requesting user", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } })
    findFirst.mockResolvedValue(null)

    const response = await makeRequest("someone-elses-authenticator")

    expect(response.status).toBe(404)
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "someone-elses-authenticator", userId: "user-1" } })
    expect(del).not.toHaveBeenCalled()
  })

  it("deletes the authenticator and returns 200 when it belongs to the requesting user", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } })
    findFirst.mockResolvedValue({ id: "authenticator-1", userId: "user-1" })
    del.mockResolvedValue({ id: "authenticator-1" })

    const response = await makeRequest("authenticator-1")
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ success: true })
    expect(del).toHaveBeenCalledWith({ where: { id: "authenticator-1" } })
  })
})
