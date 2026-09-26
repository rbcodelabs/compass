import { beforeEach, describe, expect, it, vi } from "vitest"

import { createOAuthStore } from "../helpers/oauth-store"
import type { AppTransactionClient } from "@/lib/db"

const store = createOAuthStore()
vi.mock("@/lib/db", () => ({ default: () => store.prisma }))

import {
  issueAuthorizationCodeWithEvent,
  issueAuthorizationCodeWithEventInTransaction,
} from "@/lib/oauth/authorization-events"
import { hashOAuthToken } from "@/lib/oauth/tokens"

const REQUEST = {
  clientId: "cmp_oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  userId: "user-1",
  redirectUri: "https://client.example:8443/callback/path?next=ignored#fragment",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  scope: "mcp:read mcp:write",
  resource: "https://compass.example.com/api/mcp",
  authorizationMode: "USER" as const,
  agentId: null,
}

beforeEach(() => {
  store.reset()
  vi.clearAllMocks()
})

describe("OAuth USER authorization events", () => {
  it.each(["INTERACTIVE_CONSENT", "REMEMBERED_CONSENT"] as const)(
    "records %s with normalized, secret-free provenance",
    async (source) => {
      const issued = await issueAuthorizationCodeWithEvent(REQUEST, {
        source,
        clientNameSnapshot: "Desktop Client",
      })

      expect(store.oAuthAuthorizationEvent.rows).toEqual([
        expect.objectContaining({
          eventType: "USER_OVERRIDE_AUTHORIZED",
          source,
          authorizationCodeId: issued.authorizationCodeId,
          userId: "user-1",
          clientId: REQUEST.clientId,
          clientNameSnapshot: "Desktop Client",
          redirectOrigin: "https://client.example:8443",
          authorizationMode: "USER",
          agentId: null,
          scope: "mcp:read mcp:write",
        }),
      ])
      const serialized = JSON.stringify(store.oAuthAuthorizationEvent.rows[0])
      expect(serialized).not.toContain(REQUEST.codeChallenge)
      expect(serialized).not.toContain(hashOAuthToken(issued.code))
      expect(serialized).not.toContain("callback/path")
      expect(serialized).not.toContain("next=ignored")
      expect(serialized).not.toContain("fragment")
    },
  )

  it("does not write a USER override event for AGENT authorization", async () => {
    await issueAuthorizationCodeWithEvent(
      { ...REQUEST, authorizationMode: "AGENT", agentId: "agent-1" },
      { source: "INTERACTIVE_CONSENT", clientNameSnapshot: "Desktop Client" },
    )

    expect(store.oAuthAuthorizationCode.rows).toHaveLength(1)
    expect(store.oAuthAuthorizationEvent.rows).toHaveLength(0)
  })

  it("returns no code when event persistence fails", async () => {
    store.oAuthAuthorizationEvent.create.mockRejectedValueOnce(new Error("event write failed"))

    await expect(
      issueAuthorizationCodeWithEvent(REQUEST, {
        source: "INTERACTIVE_CONSENT",
        clientNameSnapshot: "Desktop Client",
      }),
    ).rejects.toThrow("event write failed")

    expect(store.oAuthAuthorizationCode.rows).toHaveLength(0)
    expect(store.oAuthAuthorizationEvent.rows).toHaveLength(0)
  })

  it("can join the caller's transaction so consent, code, and event share one boundary", async () => {
    await store.prisma.$transaction(async (tx) => {
      await issueAuthorizationCodeWithEventInTransaction(
        REQUEST,
        { source: "INTERACTIVE_CONSENT", clientNameSnapshot: "Desktop Client" },
        new Date("2026-09-20T00:00:00.000Z"),
        tx as unknown as AppTransactionClient,
      )
    })

    expect(store.oAuthAuthorizationCode.rows).toHaveLength(1)
    expect(store.oAuthAuthorizationEvent.rows).toHaveLength(1)
  })
})
