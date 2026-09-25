// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

import { McpConnectorsPanel } from "@/components/settings/mcp-connectors-panel"

const v0 = { slug: "v0", displayName: "v0", serverUrl: "https://v0.app/api/mcp", connected: false }

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  router.refresh.mockReset()
})

describe("McpConnectorsPanel", () => {
  it("offers a real navigation to the connect route, carrying returnTo", () => {
    // Must be an <a href>, not an onClick: the route answers with a cross-origin
    // 302 that only a top-level navigation can follow.
    render(<McpConnectorsPanel connectors={[v0]} available notice={null} />)

    const link = screen.getByLabelText("Connect v0") as HTMLAnchorElement
    expect(link.tagName).toBe("A")
    expect(link.getAttribute("href")).toBe("/api/connectors/v0/connect?returnTo=%2Fsettings%2Fagents")
    expect(screen.getByText("https://v0.app/api/mcp")).toBeTruthy()
    expect(screen.getByText("Not connected.")).toBeTruthy()
  })

  it("disables connecting when the migration is unapplied", () => {
    render(<McpConnectorsPanel connectors={[v0]} available={false} notice={null} />)

    expect(screen.getByText("Connectors are not available on this deployment yet.")).toBeTruthy()
    const link = screen.getByLabelText("Connect v0")
    expect(link.getAttribute("aria-disabled")).toBe("true")
    expect(link.className).toContain("pointer-events-none")
  })

  it("shows Disconnect instead of Connect once connected", () => {
    render(<McpConnectorsPanel connectors={[{ ...v0, connected: true }]} available notice={null} />)

    expect(screen.getByLabelText("Disconnect v0")).toBeTruthy()
    expect(screen.queryByLabelText("Connect v0")).toBeNull()
    expect(screen.getByText("Connected to your account.")).toBeTruthy()
  })

  it("disconnects, and says so when the provider was also told", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ disconnected: true, revokedAtProvider: true }) })
    vi.stubGlobal("fetch", fetchMock)
    render(<McpConnectorsPanel connectors={[{ ...v0, connected: true }]} available notice={null} />)

    fireEvent.click(screen.getByLabelText("Disconnect v0"))

    await waitFor(() => expect(screen.getByLabelText("Connect v0")).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledWith("/api/connectors/v0", { method: "DELETE" })
    expect(screen.getByText(/revoked at v0/)).toBeTruthy()
    expect(router.refresh).toHaveBeenCalled()
  })

  it("says plainly when Compass dropped the token but could not revoke it upstream", async () => {
    // The distinction matters: the user may still want to revoke Compass at the
    // provider themselves, and hiding it would imply a cleanup that did not happen.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ disconnected: true, revokedAtProvider: false }) }))
    render(<McpConnectorsPanel connectors={[{ ...v0, connected: true }]} available notice={null} />)

    fireEvent.click(screen.getByLabelText("Disconnect v0"))

    await waitFor(() => expect(screen.getByText(/Compass no longer holds a token/)).toBeTruthy())
  })

  it("reports a failed disconnect without claiming it worked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    render(<McpConnectorsPanel connectors={[{ ...v0, connected: true }]} available notice={null} />)

    fireEvent.click(screen.getByLabelText("Disconnect v0"))

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not disconnect v0."))
    // Still shown as connected, because it still is.
    expect(screen.getByLabelText("Disconnect v0")).toBeTruthy()
  })

  it("renders the callback's success notice", () => {
    render(<McpConnectorsPanel connectors={[{ ...v0, connected: true }]} available notice={{ slug: "v0", connected: true, error: null }} />)

    expect(screen.getByText("v0 connected.")).toBeTruthy()
  })

  it("translates a known callback error code", () => {
    render(<McpConnectorsPanel connectors={[v0]} available notice={{ slug: "v0", connected: false, error: "WRONG_USER" }} />)

    expect(screen.getByRole("alert").textContent).toContain("started from a different Compass account")
  })

  it("falls through to the raw code for an unrecognised error", () => {
    // A code nobody has mapped yet is exactly what a bug report needs to quote,
    // so it is shown rather than swallowed into a generic message.
    render(<McpConnectorsPanel connectors={[v0]} available notice={{ slug: "v0", connected: false, error: "SOMETHING_NEW" }} />)

    expect(screen.getByRole("alert").textContent).toContain("SOMETHING_NEW")
  })
})
