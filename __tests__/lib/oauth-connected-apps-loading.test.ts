import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  oAuthConsent: { findMany: vi.fn() },
  oAuthClient: { findMany: vi.fn() },
  oAuthToken: { findMany: vi.fn() },
  agent: { findMany: vi.fn() },
  agentWorkspaceGrant: { findMany: vi.fn() },
  workspace: { findMany: vi.fn() },
}))

vi.mock("@/lib/db", () => ({ default: () => db }))

import { getConnectedAppsForUser } from "@/lib/oauth/connected-apps"

beforeEach(() => {
  vi.resetAllMocks()
  db.oAuthConsent.findMany.mockResolvedValue([
    {
      id: "consent",
      clientId: "client",
      scope: "mcp:read",
      authorizationMode: "AGENT",
      agentId: "agent",
      grantedAt: new Date("2026-09-19T10:00:00Z"),
    },
    {
      id: "corrupt-consent",
      clientId: "other-client",
      scope: "mcp:read",
      authorizationMode: "AGENT",
      agentId: "another-users-agent",
      grantedAt: new Date("2026-09-19T09:00:00Z"),
    },
  ])
  db.oAuthClient.findMany.mockResolvedValue([
    { clientId: "client", clientName: "Geode", redirectUris: ["http://localhost/callback"] },
    { clientId: "other-client", clientName: "Other", redirectUris: ["http://localhost/callback"] },
  ])
  db.oAuthToken.findMany.mockResolvedValue([])
  db.agent.findMany.mockResolvedValue([{ id: "agent", name: "Product agent" }])
  db.agentWorkspaceGrant.findMany.mockResolvedValue([])
  db.workspace.findMany.mockResolvedValue([])
})

describe("getConnectedAppsForUser", () => {
  it("scopes consent, token, agent, and workspace reads to the signed-in account", async () => {
    await getConnectedAppsForUser("owner")

    expect(db.oAuthConsent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "owner" } }))
    expect(db.oAuthToken.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "owner", clientId: { in: ["client", "other-client"] } },
    }))
    expect(db.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["agent", "another-users-agent"] }, ownerUserId: "owner" },
    }))
    expect(db.workspace.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { members: { some: { userId: "owner" } } },
    }))
    expect(db.agentWorkspaceGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { agentId: { in: ["agent"] }, revokedAt: null },
    }))
  })
})
