// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const signIn = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock("next-auth/webauthn", () => ({ signIn }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { AccountPasskeysPanel } from "@/components/settings/account-passkeys-panel"

const AUTHENTICATORS = [
  {
    id: "authenticator-1",
    credentialDeviceType: "multiDevice",
    credentialBackedUp: true,
    createdAt: "2026-09-01T00:00:00.000Z",
  },
]

describe("AccountPasskeysPanel", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("calls signIn(\"passkey\", { action: \"register\" }) when adding a passkey", async () => {
    signIn.mockResolvedValue(undefined)
    render(<AccountPasskeysPanel enabled authenticators={[]} />)

    fireEvent.click(screen.getByRole("button", { name: /add a passkey/i }))

    await waitFor(() => expect(signIn).toHaveBeenCalledWith("passkey", { action: "register" }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it("hides the add-passkey control when disabled but still lists existing passkeys", () => {
    render(<AccountPasskeysPanel enabled={false} authenticators={AUTHENTICATORS} />)

    expect(screen.queryByRole("button", { name: /add a passkey/i })).toBeNull()
    expect(screen.getByText(/multiDevice/i)).toBeInTheDocument()
  })

  it("lists an existing passkey's device type and creation date", () => {
    render(<AccountPasskeysPanel enabled authenticators={AUTHENTICATORS} />)

    expect(screen.getByText(/multiDevice/i)).toBeInTheDocument()
    expect(screen.getByText(/2026-09-01/)).toBeInTheDocument()
  })

  it("revokes a passkey via DELETE only after the confirmation dialog is accepted", async () => {
    global.fetch = fetchMock
    fetchMock.mockResolvedValue({ ok: true })
    render(<AccountPasskeysPanel enabled authenticators={AUTHENTICATORS} />)

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }))
    // Confirmation dialog is open; the DELETE must not have fired yet.
    expect(fetchMock).not.toHaveBeenCalled()

    const confirmButton = await screen.findByRole("button", { name: /^confirm$|^revoke passkey$/i })
    fireEvent.click(confirmButton)

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/webauthn/authenticators/authenticator-1", { method: "DELETE" })
    )
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })
})
