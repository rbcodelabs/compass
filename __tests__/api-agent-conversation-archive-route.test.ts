/** TASK-195 S2: the PATCH archive route. 403 for a member without rights, 404 for anyone who cannot see it. */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ auth: vi.fn(), archive: vi.fn() }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/conversation-archive", () => ({ setConversationArchived: mocks.archive }))

import { PATCH } from "@/app/api/agent/conversations/[conversationId]/route"

const WS = "0b6f3c9e-6a1d-4c1e-9d3a-2f0c8e7b5a41"
const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const call = (body: unknown, id = CONV, ws: string | null = WS) =>
  PATCH(
    new Request(`http://localhost/api/agent/conversations/${id}${ws ? `?workspaceId=${ws}` : ""}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ conversationId: id }) },
  )

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
  mocks.archive.mockResolvedValue({ ok: true, archived: true, changed: true })
})

describe("PATCH /api/agent/conversations/[id]", () => {
  it("requires a session, a workspace and a boolean", async () => {
    mocks.auth.mockResolvedValueOnce(null)
    expect((await call({ archived: true })).status).toBe(401)
    expect((await call({ archived: true }, CONV, null)).status).toBe(400)
    expect((await call({ archived: "yes" })).status).toBe(400)
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it("404s a malformed id without reaching the service", async () => {
    expect((await call({ archived: true }, "nope")).status).toBe(404)
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it("passes the session user, never a body field, as the actor", async () => {
    const res = await call({ archived: true, userId: "someone-else" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ archived: true, changed: true })
    expect(mocks.archive).toHaveBeenCalledWith({ conversationId: CONV, workspaceId: WS, userId: "user-1", archived: true })
  })

  it("maps the service refusals to 403 and 404", async () => {
    mocks.archive.mockResolvedValueOnce({ ok: false, status: 403 })
    expect((await call({ archived: true })).status).toBe(403)
    mocks.archive.mockResolvedValueOnce({ ok: false, status: 404 })
    expect((await call({ archived: false })).status).toBe(404)
  })
})
