/** Route-level checks: the server refuses what the UI hides, and unlock is required first. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  state: { share: null as null | Record<string, unknown>, unlocked: false },
  sendEmail: vi.fn(),
  deleteMany: vi.fn(async () => ({ count: 1 })),
}))

vi.mock("@/lib/db", () => ({ default: () => ({ portalVerificationToken: { deleteMany: h.deleteMany } }) }))
vi.mock("@/lib/artifact-share", async () => {
  const actual = await vi.importActual<typeof import("@/lib/artifact-share")>("@/lib/artifact-share")
  return {
    ...actual,
    resolveShareByToken: async () => h.state.share,
    verifyShareSession: async () => h.state.unlocked,
  }
})
vi.mock("@/lib/artifact-share-comments", async () => {
  const actual = await vi.importActual<typeof import("@/lib/artifact-share-comments")>("@/lib/artifact-share-comments")
  return {
    ...actual,
    verifyCommenter: async () => null,
    issueMagicToken: async () => ({ rawToken: "t".repeat(40) }),
    sendShareSignInEmail: h.sendEmail,
  }
})

import { GET as listComments, POST as postComment } from "@/app/s/[token]/comments/route"
import { POST as sendLink } from "@/app/s/[token]/auth/send/route"

const params = { params: Promise.resolve({ token: "t".repeat(43) }) }
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("https://compass.test/s/x/y", {
    method,
    headers: { host: "compass.test", "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const liveShare = (commentsEnabled = true) => ({
  id: "s1", artifactId: "a1", workspaceId: "w1", passwordChangedAt: new Date(0), commentsEnabled,
})

beforeEach(() => {
  h.state.share = liveShare()
  h.state.unlocked = true
  h.sendEmail.mockReset()
  h.deleteMany.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("share comment routes", () => {
  it("404s for an unknown link and for a viewer who has not unlocked", async () => {
    h.state.share = null
    expect((await listComments(req("GET"), params)).status).toBe(404)
    h.state.share = liveShare()
    h.state.unlocked = false
    expect((await listComments(req("GET"), params)).status).toBe(404)
    expect((await sendLink(req("POST", { email: "a@b.co" }), params)).status).toBe(404)
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it("403s everything when commenting is off (no Resend key or owner turned it off) and sends no email", async () => {
    h.state.share = liveShare(false)
    expect((await listComments(req("GET"), params)).status).toBe(403)
    expect((await postComment(req("POST", { body: "hi" }), params)).status).toBe(403)
    expect((await sendLink(req("POST", { email: "a@b.co" }), params)).status).toBe(403)
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it("401s an unlocked viewer who has not confirmed an email", async () => {
    expect((await listComments(req("GET"), params)).status).toBe(401)
    expect((await postComment(req("POST", { body: "hi" }), params)).status).toBe(401)
  })

  it("rejects cross-origin POSTs before doing anything", async () => {
    const cross = { origin: "https://evil.example" }
    expect((await postComment(req("POST", { body: "hi" }, cross), params)).status).toBe(403)
    expect((await sendLink(req("POST", { email: "a@b.co" }, cross), params)).status).toBe(403)
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it("sends one email and answers generically", async () => {
    const response = await sendLink(req("POST", { email: "a@b.co" }), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    expect(h.deleteMany).not.toHaveBeenCalled()
  })

  it("on provider failure: no leak of the error, and the undelivered token is deleted", async () => {
    h.sendEmail.mockRejectedValueOnce(new Error("resend 500 key=secret"))
    const response = await sendLink(req("POST", { email: "a@b.co" }), params)
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain("secret")
    expect(h.deleteMany).toHaveBeenCalledTimes(1)
  })
})
