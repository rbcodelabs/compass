import { describe, expect, it } from "vitest"
import { buildConnectedApps } from "@/lib/oauth/connected-apps"

const workspaces = new Map([
  ["workspace-a", { workspaceName: "Compass", organizationName: "RB Code Labs" }],
  ["workspace-b", { workspaceName: "Personal", organizationName: "Home" }],
])

describe("connected OAuth apps", () => {
  it("shows an agent binding with only its effective granted workspaces", () => {
    const [connection] = buildConnectedApps({
      consents: [{ id: "consent", clientId: "client", scope: "mcp:read mcp:write", authorizationMode: "AGENT", agentId: "agent", grantedAt: new Date("2026-09-19T10:00:00Z") }],
      clients: [{ clientId: "client", clientName: "Geode", redirectUris: ["http://127.0.0.1:3118/callback", "https://agent.example/oauth/callback"] }],
      tokens: [{ clientId: "client", lastUsedAt: new Date("2026-09-19T12:00:00Z") }],
      agents: [{ id: "agent", name: "Product agent" }],
      grants: [
        { agentId: "agent", workspaceId: "workspace-a", access: "WRITE" },
        { agentId: "agent", workspaceId: "workspace-not-owned", access: "WRITE" },
      ],
      memberWorkspaces: workspaces,
    })

    expect(connection).toMatchObject({
      id: "consent",
      clientName: "Geode",
      redirectHosts: ["127.0.0.1:3118", "agent.example"],
      binding: { mode: "AGENT", agentName: "Product agent" },
      scopes: ["mcp:read", "mcp:write"],
      workspaces: [{ workspaceName: "Compass", organizationName: "RB Code Labs", access: "WRITE" }],
      lastUsedAt: new Date("2026-09-19T12:00:00Z"),
    })
  })

  it("shows every current membership for an explicit full-account override", () => {
    const [connection] = buildConnectedApps({
      consents: [{ id: "consent", clientId: "client", scope: "mcp:read", authorizationMode: "USER", agentId: null, grantedAt: new Date("2026-09-19T10:00:00Z") }],
      clients: [{ clientId: "client", clientName: "Claude", redirectUris: ["not a URL"] }],
      tokens: [],
      agents: [],
      grants: [],
      memberWorkspaces: workspaces,
    })

    expect(connection.binding).toEqual({ mode: "USER", agentName: null })
    expect(connection.redirectHosts).toEqual(["Unknown host"])
    expect(connection.workspaces).toEqual([
      { workspaceName: "Personal", organizationName: "Home", access: "FULL" },
      { workspaceName: "Compass", organizationName: "RB Code Labs", access: "FULL" },
    ])
    expect(connection.lastUsedAt).toBeNull()
  })

  it("fails closed for a missing client or unrecognised binding mode", () => {
    const connections = buildConnectedApps({
      consents: [
        { id: "missing-client", clientId: "missing", scope: "mcp:read", authorizationMode: "AGENT", agentId: "agent", grantedAt: new Date() },
        { id: "bad-mode", clientId: "client", scope: "mcp:read", authorizationMode: "SOMETHING_ELSE", agentId: null, grantedAt: new Date() },
      ],
      clients: [{ clientId: "client", clientName: "Known", redirectUris: [] }],
      tokens: [],
      agents: [{ id: "agent", name: "Agent" }],
      grants: [],
      memberWorkspaces: workspaces,
    })

    expect(connections).toEqual([])
  })
})
