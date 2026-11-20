// @vitest-environment jsdom
// Unit tests do not run Next's Server Action transform; keep its server dependencies outside this client boundary.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/links/conversation-actions", () => ({ removeObjectConversationLink: vi.fn() }))
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateArtifact: vi.fn(),
  replaceArtifactRevision: vi.fn(),
  archiveArtifact: vi.fn(),
  linkArtifact: vi.fn(),
  unlinkArtifact: vi.fn(),
  unlinkArtifactDecision: vi.fn(),
  enableArtifactShareAction: vi.fn(),
  previewProps: [] as Array<Record<string, unknown>>,
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/hooks/use-live-refresh", () => ({ useLiveRefresh: vi.fn() }))
vi.mock("@/components/links/linked-entities-section", () => ({
  LinkedEntitiesSection: ({ title }: { title?: string }) => <section aria-label={title ?? "Linked entities"}>Experiment links stub</section>,
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({
  updateArtifact: mocks.updateArtifact,
  replaceArtifactRevision: mocks.replaceArtifactRevision,
  archiveArtifact: mocks.archiveArtifact,
  linkArtifact: mocks.linkArtifact,
  unlinkArtifact: mocks.unlinkArtifact,
  unlinkArtifactDecision: mocks.unlinkArtifactDecision,
  enableArtifactShareAction: mocks.enableArtifactShareAction,
  changeArtifactSharePasswordAction: vi.fn(),
  revokeArtifactShareAction: vi.fn(),
  rotateArtifactShareLinkAction: vi.fn(),
  setArtifactShareCommentsAction: vi.fn(),
}))
vi.mock("@/components/docs/artifact-preview", () => ({
  ArtifactPreview: (props: Record<string, unknown>) => {
    mocks.previewProps.push(props)
    return <div data-testid="artifact-preview-stub" data-bleed={props.bleed ? "true" : "false"} />
  },
}))

import { ArtifactDetail } from "@/components/docs/artifact-detail"

const fetchMock = vi.fn()

function buildProps(overrides: Partial<Parameters<typeof ArtifactDetail>[0]> = {}): Parameters<typeof ArtifactDetail>[0] {
  return {
    workspaceId: "ws-1",
    basePath: "/acme/product/docs",
    html: "<html><body><h1>Funnel</h1></body></html>",
    artifact: {
      id: "art-1",
      title: "Onboarding funnel prototype",
      description: "Interactive prototype for Q4 review.",
      sourceType: "HTML_UPLOAD",
      kind: "DOCUMENT",
      status: "ACTIVE",
      currentRevision: { externalUrl: null, thumbnail: null },
      revisions: [
        { id: "rev-2", revisionNumber: 2, filename: "onboarding-v2.html", byteSize: 2048, externalUrl: null, createdAt: "2026-11-10T14:00:00Z" },
        { id: "rev-1", revisionNumber: 1, filename: "onboarding-v1.html", byteSize: 1024, externalUrl: null, createdAt: "2026-11-04T09:00:00Z" },
      ],
    },
    shareState: {
      enabled: false,
      enabledAt: null,
      passwordChangedAt: null,
      commentsEnabled: false,
      commentingAvailable: true,
      events: [],
    },
    solutions: [
      { id: "sol-1", title: "Guided setup checklist", linked: true },
      { id: "sol-2", title: "Template gallery", linked: false },
    ],
    decisions: [{ id: "dec-1", title: "Ship guided setup to all?", state: "PENDING" }],
    ...overrides,
  }
}

function setDesktopViewport(matches = true, rowWidth = 1440) {
  vi.stubGlobal("matchMedia", () => ({
    matches,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: rowWidth } as DOMRect)
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.previewProps.length = 0
  fetchMock.mockReset().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 })))
  vi.stubGlobal("fetch", fetchMock)
  setDesktopViewport(true, 1440)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.cookie = "compass_panel_artifactComments=; Path=/; Max-Age=0"
})

describe("ArtifactDetail full-bleed stage & inspector drawer (SOL-101)", () => {
  it("opens full-bleed with the inspector drawer closed by default and renders slim top-bar context", () => {
    const { container } = render(<ArtifactDetail {...buildProps()} />)

    expect(screen.getByRole("heading", { level: 1, name: "Onboarding funnel prototype" })).toBeInTheDocument()
    expect(screen.getByText("HTML prototype")).toBeInTheDocument()
    expect(screen.getByText("Rev 2")).toBeInTheDocument()

    // No centered max-w-5xl wrapper around the HTML stage; preview receives bleed=true.
    expect(container.querySelector(".max-w-5xl")).toBeNull()
    expect(screen.getByTestId("artifact-preview-stub")).toHaveAttribute("data-bleed", "true")

    // Inspector is closed by default.
    expect(screen.queryByRole("complementary", { name: "Artifact inspector" })).toBeNull()
    expect(screen.queryByRole("dialog", { name: "Artifact inspector" })).toBeNull()
    expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByRole("button", { name: "Comments" })).toHaveAttribute("aria-expanded", "false")
  })

  it("toggles between Details and Comments triggers, remembers the last non-comment tab, and restores focus on close", () => {
    render(<ArtifactDetail {...buildProps()} />)
    const detailsBtn = screen.getByRole("button", { name: "Details" })
    const commentsBtn = screen.getByRole("button", { name: "Comments" })

    // Open Details -> starts on Details tab at 360px default width.
    fireEvent.click(detailsBtn)
    const aside = screen.getByRole("complementary", { name: "Artifact inspector" })
    expect(aside).toBeVisible()
    expect(aside.style.getPropertyValue("--panel-w")).toBe("360px")
    expect(detailsBtn).toHaveAttribute("aria-expanded", "true")
    expect(commentsBtn).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true")

    // Switch to Links tab, then click Comments top-bar button -> switches to Comments without closing.
    fireEvent.click(screen.getByRole("tab", { name: "Links" }))
    expect(screen.getByRole("tab", { name: "Links" })).toHaveAttribute("aria-selected", "true")

    fireEvent.click(commentsBtn)
    expect(screen.getByRole("complementary", { name: "Artifact inspector" })).toBeVisible()
    expect(commentsBtn).toHaveAttribute("aria-expanded", "true")
    expect(detailsBtn).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByRole("tab", { name: "Comments" })).toHaveAttribute("aria-selected", "true")

    // Clicking Details top-bar button switches back to the remembered Links tab!
    fireEvent.click(detailsBtn)
    expect(detailsBtn).toHaveAttribute("aria-expanded", "true")
    expect(commentsBtn).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByRole("tab", { name: "Links" })).toHaveAttribute("aria-selected", "true")

    // Clicking Details again while on a non-comments tab closes the drawer and focuses Details.
    fireEvent.click(detailsBtn)
    expect(screen.queryByRole("complementary", { name: "Artifact inspector" })).toBeNull()
    expect(detailsBtn).toHaveFocus()

    // Clicking Comments opens Comments; clicking Close panel returns focus to Comments.
    fireEvent.click(commentsBtn)
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }))
    expect(screen.queryByRole("complementary", { name: "Artifact inspector" })).toBeNull()
    expect(commentsBtn).toHaveFocus()
  })

  it("renders all 5 tabs and supports ArrowRight, ArrowLeft, Home, and End keyboard navigation", async () => {
    render(<ArtifactDetail {...buildProps()} />)
    fireEvent.click(screen.getByRole("button", { name: "Details" }))

    const tablist = screen.getByRole("tablist", { name: "Inspector sections" })
    const tabs = within(tablist).getAllByRole("tab")
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Details", "Links", "Share", "History", "Comments"])

    // Details tab content
    expect(screen.getByLabelText("Title")).toHaveValue("Onboarding funnel prototype")
    expect(screen.getByLabelText("Description")).toHaveValue("Interactive prototype for Q4 review.")
    expect(screen.getByRole("button", { name: "Save details" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Replace current revision" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Archive" })).toBeVisible()

    // ArrowRight -> Links
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" })
    expect(tabs[1]).toHaveAttribute("aria-selected", "true")
    expect(tabs[1]).toHaveFocus()
    expect(screen.getByRole("heading", { name: "Linked solutions" })).toBeVisible()
    expect(screen.getByLabelText("Linked experiments")).toBeVisible()
    expect(screen.getByRole("heading", { name: "Linked decisions" })).toBeVisible()

    // ArrowRight -> Share
    fireEvent.keyDown(tabs[1], { key: "ArrowRight" })
    expect(tabs[2]).toHaveAttribute("aria-selected", "true")
    expect(tabs[2]).toHaveFocus()
    expect(screen.getByRole("heading", { name: "Share with people outside Compass" })).toBeVisible()

    // ArrowRight -> History
    fireEvent.keyDown(tabs[2], { key: "ArrowRight" })
    expect(tabs[3]).toHaveAttribute("aria-selected", "true")
    expect(tabs[3]).toHaveFocus()
    const historyItems = screen.getAllByRole("listitem")
    expect(historyItems[0]).toHaveAttribute("data-current", "true")
    expect(historyItems[0]).toHaveTextContent("Revision 2")
    expect(historyItems[0]).toHaveTextContent("onboarding-v2.html")
    expect(historyItems[1]).not.toHaveAttribute("data-current")
    expect(historyItems[1]).toHaveTextContent("Revision 1")

    // End -> Comments, Home -> Details, ArrowLeft wraps Details -> Comments
    fireEvent.keyDown(tabs[3], { key: "End" })
    expect(tabs[4]).toHaveAttribute("aria-selected", "true")
    expect(tabs[4]).toHaveFocus()
    expect(await screen.findByText("No comments yet.")).toBeVisible()

    fireEvent.keyDown(tabs[4], { key: "Home" })
    expect(tabs[0]).toHaveAttribute("aria-selected", "true")
    expect(tabs[0]).toHaveFocus()

    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" })
    expect(tabs[4]).toHaveAttribute("aria-selected", "true")
    expect(tabs[4]).toHaveFocus()
  })

  it("auto-opens the drawer on the Comments tab when initialFocusedCommentId (?comment=) is set", async () => {
    render(<ArtifactDetail {...buildProps({ initialFocusedCommentId: "comment-42" })} />)

    expect(screen.getByRole("complementary", { name: "Artifact inspector" })).toBeVisible()
    expect(screen.getByRole("tab", { name: "Comments" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("button", { name: "Comments" })).toHaveAttribute("aria-expanded", "true")
    expect(await screen.findByText("No comments yet.")).toBeVisible()
  })

  it("preserves ArtifactSharePanel one-time link state across tab switches including first Comments open", async () => {
    mocks.enableArtifactShareAction.mockResolvedValue({ rawToken: "secret-token-xyz", password: "generated-password-123" })
    const { rerender } = render(<ArtifactDetail {...buildProps()} />)

    fireEvent.click(screen.getByRole("button", { name: "Details" }))
    fireEvent.click(screen.getByRole("tab", { name: "Share" }))
    fireEvent.click(screen.getByRole("button", { name: "Turn on sharing" }))

    await waitFor(() => expect(mocks.enableArtifactShareAction).toHaveBeenCalled())
    // Simulate router.refresh() returning enabled shareState while keeping component mounted.
    rerender(
      <ArtifactDetail
        {...buildProps({
          shareState: { enabled: true, enabledAt: "2026-11-16T20:00:00Z", passwordChangedAt: "2026-11-16T20:00:00Z", commentsEnabled: false, commentingAvailable: true, events: [] },
        })}
      />,
    )

    expect(screen.getByLabelText("Share link")).toHaveValue(`${window.location.origin}/s/secret-token-xyz`)
    expect(screen.getByLabelText("Generated password")).toHaveValue("generated-password-123")

    // Switch through Links and Comments (first-ever Comments visit!) and return to Share.
    fireEvent.click(screen.getByRole("tab", { name: "Links" }))
    fireEvent.click(screen.getByRole("tab", { name: "Comments" }))
    await screen.findByText("No comments yet.")
    fireEvent.click(screen.getByRole("tab", { name: "Share" }))

    expect(screen.getByLabelText("Share link")).toHaveValue(`${window.location.origin}/s/secret-token-xyz`)
    expect(screen.getByLabelText("Generated password")).toHaveValue("generated-password-123")
  })

  it("renders as a bottom Sheet dialog on narrow/mobile viewports (<1024px)", () => {
    setDesktopViewport(false, 390)
    render(<ArtifactDetail {...buildProps()} />)

    fireEvent.click(screen.getByRole("button", { name: "Details" }))
    expect(screen.queryByRole("complementary", { name: "Artifact inspector" })).toBeNull()
    const dialog = screen.getByRole("dialog", { name: "Artifact inspector" })
    expect(dialog).toBeVisible()
    expect(dialog).toHaveAttribute("data-side", "bottom")
    expect(within(dialog).getByRole("tablist", { name: "Inspector sections" })).toBeVisible()
  })
})
