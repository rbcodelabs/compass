import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/artifact-share", () => ({ resolveShareByToken: vi.fn(), shareSessionCookieName: vi.fn(), verifyShareSession: vi.fn() }))
vi.mock("@/lib/artifact-share-comments", () => ({ assertCommentingOpen: vi.fn(), ShareCommentError: class extends Error {} }))

import type { NextRequest } from "next/server"
import { sameOriginOrNull } from "@/app/s/[token]/_guard"

function req(headers: Record<string, string>) {
  return { headers: new Headers(headers) } as unknown as NextRequest
}

describe("sameOriginOrNull", () => {
  it("allows a missing Origin and a matching Origin", () => {
    expect(sameOriginOrNull(req({ host: "app.test" }))).toBeNull()
    expect(sameOriginOrNull(req({ host: "app.test", origin: "https://app.test" }))).toBeNull()
  })

  it("rejects a foreign Origin with 403", () => {
    expect(sameOriginOrNull(req({ host: "app.test", origin: "https://evil.test" }))?.status).toBe(403)
  })

  it("rejects the opaque 'null' Origin with 403 instead of throwing", () => {
    expect(sameOriginOrNull(req({ host: "app.test", origin: "null" }))?.status).toBe(403)
  })
})
