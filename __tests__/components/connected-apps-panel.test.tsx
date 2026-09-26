// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({ revoke: vi.fn(), reconnect: vi.fn() }))
vi.mock("@/app/settings/agents/actions", () => ({
  revokeOAuthConnection: actions.revoke,
  reconnectOAuthConnection: actions.reconnect,
}))

import { ConnectedAppsPanel } from "@/components/settings/connected-apps-panel"

const connection = {
  id: "consent",
  clientName: "Geode",
  redirectHosts: ["127.0.0.1:3118"],
  binding: { mode: "AGENT" as const, agentName: "Product agent" },
  scopes: ["mcp:read", "mcp:write"],
  workspaces: [{ workspaceName: "Compass", organizationName: "RB Code Labs", access: "WRITE" as const }],
  grantedAt: new Date("2026-09-19T10:00:00Z"),
  lastUsedAt: new Date("2026-09-19T12:00:00Z"),
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe("ConnectedAppsPanel", () => {
  it("renders the client, redirect host, binding, scopes, reach, and last use", () => {
    render(<ConnectedAppsPanel connections={[connection]} />)

    expect(screen.getByText("Geode")).toBeTruthy()
    expect(screen.getByText("127.0.0.1:3118")).toBeTruthy()
    expect(screen.getByText("Product agent")).toBeTruthy()
    expect(screen.getByText("mcp:read, mcp:write")).toBeTruthy()
    expect(screen.getByText(/RB Code Labs · Compass · Read and write/)).toBeTruthy()
    expect(screen.getByText(/Sep 19, 2026/)).toBeTruthy()
  })

  it("revokes a connection and removes it from the panel", async () => {
    actions.revoke.mockResolvedValue(undefined)
    render(<ConnectedAppsPanel connections={[connection]} />)

    fireEvent.click(screen.getByRole("button", { name: "Revoke Geode" }))

    await waitFor(() => expect(actions.revoke).toHaveBeenCalledWith("consent"))
    expect(screen.getByText("No connected apps.")).toBeTruthy()
  })

  it("forgets the binding before asking the user to reconnect", async () => {
    actions.reconnect.mockResolvedValue(undefined)
    render(<ConnectedAppsPanel connections={[connection]} />)

    fireEvent.click(screen.getByRole("button", { name: "Reconnect Geode as a different agent" }))

    await waitFor(() => expect(actions.reconnect).toHaveBeenCalledWith("consent"))
    expect(screen.getByRole("status").textContent).toContain("Reconnect Geode from the app to choose a different authorization binding.")
  })
})
