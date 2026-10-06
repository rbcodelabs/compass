// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { grant, revoke } = vi.hoisted(() => ({ grant: vi.fn(), revoke: vi.fn() }))
vi.mock("@/app/[orgSlug]/settings/actions", () => ({
  grantAgentScoringModelAdmin: grant,
  revokeAgentScoringModelAdmin: revoke,
}))

import { AgentAccessPanel } from "@/components/settings/agent-access-panel"
import type { AgentAccessRow } from "@/lib/agent-org-admin-access"

const base: AgentAccessRow = { agentId: "a1", agentName: "Scorer", ownerName: "Olive", granted: false, grantedByName: null, inactive: false }

beforeEach(() => {
  grant.mockResolvedValue({ ok: true })
  revoke.mockResolvedValue({ ok: true })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("AgentAccessPanel", () => {
  it("renders nothing for a non-admin", () => {
    const { container } = render(<AgentAccessPanel orgSlug="org" rows={[base]} canManage={false} agentsEnabled />)
    expect(container.innerHTML).toBe("")
  })

  it("states what the grant allows and that it lapses", () => {
    render(<AgentAccessPanel orgSlug="org" rows={[base]} canManage agentsEnabled />)
    expect(screen.getByText(/create, update and archive/i)).toBeTruthy()
    expect(screen.getByText(/lapses automatically/i)).toBeTruthy()
  })

  it("grants an ungranted agent", async () => {
    render(<AgentAccessPanel orgSlug="org" rows={[base]} canManage agentsEnabled />)
    expect(screen.getByText("Olive")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Allow scoring-model admin" }))
    await waitFor(() => expect(grant).toHaveBeenCalledWith("org", "a1"))
  })

  it("revokes a granted agent", async () => {
    render(<AgentAccessPanel orgSlug="org" rows={[{ ...base, granted: true, grantedByName: "Ada" }]} canManage agentsEnabled />)
    expect(screen.getByText("Granted by Ada")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }))
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("org", "a1"))
  })

  it("flags a grant whose grantor is no longer an org admin", () => {
    render(<AgentAccessPanel orgSlug="org" rows={[{ ...base, granted: true, grantedByName: "Ada", inactive: true }]} canManage agentsEnabled />)
    expect(screen.getByText(/Inactive — grantor no longer an org admin/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy()
  })

  it("shows an action error", async () => {
    grant.mockResolvedValue({ ok: false, error: "Agent not found" })
    render(<AgentAccessPanel orgSlug="org" rows={[base]} canManage agentsEnabled />)
    fireEvent.click(screen.getByRole("button", { name: "Allow scoring-model admin" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Agent not found")
  })
})
