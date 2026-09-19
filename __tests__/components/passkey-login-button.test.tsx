// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const signIn = vi.hoisted(() => vi.fn())
vi.mock("next-auth/webauthn", () => ({ signIn }))

import { PasskeyLoginButton } from "@/components/auth/passkey-login-button"

describe("PasskeyLoginButton", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    // @ts-expect-error test-only cleanup of a browser feature-detect global
    delete window.PublicKeyCredential
  })

  it("renders nothing when the browser has no WebAuthn support", () => {
    render(<PasskeyLoginButton />)
    expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull()
  })

  it("renders a sign-in button and calls signIn(\"passkey\") when supported", async () => {
    // @ts-expect-error minimal feature-detect stub, not a full implementation
    window.PublicKeyCredential = function PublicKeyCredential() {}
    signIn.mockResolvedValue(undefined)

    render(<PasskeyLoginButton />)
    const button = await screen.findByRole("button", { name: /passkey/i })
    fireEvent.click(button)

    await waitFor(() => expect(signIn).toHaveBeenCalledWith("passkey", { callbackUrl: "/dashboard" }))
  })

  it("shows an error message when the WebAuthn ceremony fails", async () => {
    // @ts-expect-error minimal feature-detect stub, not a full implementation
    window.PublicKeyCredential = function PublicKeyCredential() {}
    signIn.mockRejectedValue(new Error("The operation either timed out or was not allowed."))

    render(<PasskeyLoginButton />)
    const button = await screen.findByRole("button", { name: /passkey/i })
    fireEvent.click(button)

    expect(await screen.findByRole("alert")).toHaveTextContent(/timed out|not allowed/i)
  })
})
