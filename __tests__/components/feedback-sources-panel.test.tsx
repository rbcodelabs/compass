// @vitest-environment jsdom

/**
 * Unit tests for components/settings/feedback-sources-panel.tsx.
 *
 * No test file existed for this panel before now. These focus on the
 * PORTAL_SSO option added alongside INTERNAL_SSO and PORTAL: per the product
 * decisions in the task brief, it must always appear in the "Who can comment"
 * dropdown, but disabled with a hint until the workspace has Portal SSO
 * Identify configured (`ssoIdentifyEnabled`). Server actions are mocked; what
 * is under test is the panel's own rendering and gating logic, not the
 * mutation plumbing (covered by __tests__/feedback-source-actions.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const createFeedbackSource = vi.fn()
const updateFeedbackSource = vi.fn()
const mintFeedbackSourceToken = vi.fn()
const revokeFeedbackSourceToken = vi.fn()
const setArtifactFeedbackPublic = vi.fn()

vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/feedback-source-actions", () => ({
  createFeedbackSource: (...args: unknown[]) => createFeedbackSource(...args),
  updateFeedbackSource: (...args: unknown[]) => updateFeedbackSource(...args),
  mintFeedbackSourceToken: (...args: unknown[]) => mintFeedbackSourceToken(...args),
  revokeFeedbackSourceToken: (...args: unknown[]) => revokeFeedbackSourceToken(...args),
  setArtifactFeedbackPublic: (...args: unknown[]) => setArtifactFeedbackPublic(...args),
}))

import {
  FeedbackSourcesPanel,
  type FeedbackSourceRow,
} from "@/components/settings/feedback-sources-panel"

/**
 * Base UI's SelectItem only commits a mouse click when a `pointerdown` primed
 * `allowMouseSelectionRef` first — see __tests__/components/study-builder.test.tsx
 * and __tests__/components/roadmap-group-by-toggle.test.tsx for the same
 * recipe against the same components/ui/select.tsx primitive.
 */
function selectOption(option: HTMLElement) {
  fireEvent.pointerDown(option, { pointerType: "mouse" })
  fireEvent.click(option)
}

function source(overrides: Partial<FeedbackSourceRow> = {}): FeedbackSourceRow {
  return {
    id: "source-1",
    name: "Checkout prototype",
    artifactId: "artifact-1",
    artifactTitle: "Checkout",
    allowedOrigins: ["https://prototype.example.com"],
    enabled: true,
    authMode: "INTERNAL_SSO",
    tokens: [],
    ...overrides,
  }
}

function renderPanel(
  overrides: Partial<{ initialSources: FeedbackSourceRow[]; ssoIdentifyEnabled: boolean }> = {}
) {
  return render(
    <FeedbackSourcesPanel
      orgSlug="rbcodelabs"
      workspaceSlug="compass"
      initialSources={overrides.initialSources ?? [source()]}
      artifacts={[{ id: "artifact-1", title: "Checkout" }]}
      embedBaseUrl="https://compass.example.com"
      artifactFeedbackPublic={false}
      ssoIdentifyEnabled={overrides.ssoIdentifyEnabled ?? false}
    />
  )
}

function authModeSelect() {
  return screen.getByRole("combobox", { name: "Who can comment on Checkout prototype" })
}

afterEach(() => {
  cleanup()
  createFeedbackSource.mockReset()
  updateFeedbackSource.mockReset()
  mintFeedbackSourceToken.mockReset()
  revokeFeedbackSourceToken.mockReset()
  setArtifactFeedbackPublic.mockReset()
})

describe("FeedbackSourcesPanel — PORTAL_SSO option", () => {
  it("always lists the SSO option in the dropdown, even when the workspace is not eligible", () => {
    renderPanel({ ssoIdentifyEnabled: false })
    fireEvent.click(authModeSelect())
    expect(screen.getByRole("option", { name: /external reviewers.*sso/i })).toBeInTheDocument()
  })

  it("disables the SSO option until Portal SSO Identify is configured", () => {
    renderPanel({ ssoIdentifyEnabled: false })
    fireEvent.click(authModeSelect())
    const option = screen.getByRole("option", { name: /external reviewers.*sso/i })
    expect(option).toHaveAttribute("aria-disabled", "true")
  })

  it("refuses to select the disabled SSO option and never calls the server action", async () => {
    renderPanel({ ssoIdentifyEnabled: false })
    fireEvent.click(authModeSelect())
    const option = screen.getByRole("option", { name: /external reviewers.*sso/i })
    selectOption(option)

    // Give any (incorrect) async update a chance to land before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updateFeedbackSource).not.toHaveBeenCalled()
  })

  it("enables the SSO option once the workspace has SSO Identify configured, and selecting it saves", async () => {
    updateFeedbackSource.mockResolvedValue({ ok: true, allowedOrigins: ["https://prototype.example.com"], name: "Checkout prototype", enabled: true, authMode: "PORTAL_SSO" })
    renderPanel({ ssoIdentifyEnabled: true })
    fireEvent.click(authModeSelect())
    const option = screen.getByRole("option", { name: /external reviewers.*sso/i })
    expect(option).not.toHaveAttribute("aria-disabled", "true")

    selectOption(option)

    await waitFor(() => {
      expect(updateFeedbackSource).toHaveBeenCalledWith("rbcodelabs", "compass", "source-1", { authMode: "PORTAL_SSO" })
    })
  })

  it("hints that Portal SSO Identify must be enabled first, for a source already stored as PORTAL_SSO but not yet eligible", () => {
    renderPanel({ initialSources: [source({ authMode: "PORTAL_SSO" })], ssoIdentifyEnabled: false })
    expect(screen.getByText(/enable portal sso identify/i)).toBeInTheDocument()
  })

  it("hints at the SSO-only, no-email-fallback behavior once eligible", () => {
    renderPanel({ initialSources: [source({ authMode: "PORTAL_SSO" })], ssoIdentifyEnabled: true })
    expect(screen.getByText(/no magic-link email is ever sent/i)).toBeInTheDocument()
  })

  it("still points the PORTAL hint at the dedicated SSO-only option, once eligible", () => {
    renderPanel({ initialSources: [source({ authMode: "PORTAL" })], ssoIdentifyEnabled: true })
    expect(screen.getByText(/external reviewers, via sso/i)).toBeInTheDocument()
  })

  it("also offers the SSO option, disabled the same way, on the create-new-source form", () => {
    renderPanel({ ssoIdentifyEnabled: false })
    fireEvent.click(screen.getByRole("combobox", { name: "Who can comment" }))
    const option = screen.getByRole("option", { name: /external reviewers.*sso/i })
    expect(option).toHaveAttribute("aria-disabled", "true")
  })
})

describe("FeedbackSourcesPanel — existing modes still work", () => {
  it("still saves a switch to PORTAL, unaffected by the new option", async () => {
    updateFeedbackSource.mockResolvedValue({ ok: true, allowedOrigins: [], name: "Checkout prototype", enabled: true, authMode: "PORTAL" })
    renderPanel()
    fireEvent.click(authModeSelect())
    selectOption(screen.getByRole("option", { name: "External reviewers, by email link" }))

    await waitFor(() => {
      expect(updateFeedbackSource).toHaveBeenCalledWith("rbcodelabs", "compass", "source-1", { authMode: "PORTAL" })
    })
  })

  it("still creates a source with the chosen mode", async () => {
    createFeedbackSource.mockResolvedValue({
      ok: true,
      id: "new-source",
      token: "cmpfb_raw",
      tokenId: "token-1",
      tokenPrefix: "abcd1234",
      allowedOrigins: [],
      authMode: "INTERNAL_SSO",
    })
    renderPanel({ initialSources: [] })

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New proto" } })
    fireEvent.click(screen.getByRole("combobox", { name: "Prototype" }))
    selectOption(screen.getByRole("option", { name: "Checkout" }))
    fireEvent.click(screen.getByRole("button", { name: "Create and mint a token" }))

    await waitFor(() => {
      expect(createFeedbackSource).toHaveBeenCalledWith("rbcodelabs", "compass", {
        name: "New proto",
        artifactId: "artifact-1",
        allowedOrigins: [],
        authMode: "INTERNAL_SSO",
      })
    })
  })
})
