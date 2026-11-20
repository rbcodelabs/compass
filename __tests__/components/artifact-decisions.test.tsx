// @vitest-environment jsdom
// Unit tests do not run Next's Server Action transform; keep its server dependencies outside this client boundary.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/links/conversation-actions", () => ({ removeObjectConversationLink: vi.fn() }))
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ unlink: vi.fn(), refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
// The experiments section loads through a server action; these tests are about other parts of the page.
vi.mock("@/components/links/linked-entities-section", () => ({ LinkedEntitiesSection: () => null }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ unlinkArtifactDecision: mocks.unlink }))
vi.mock("@/components/docs/artifact-preview", () => ({ ArtifactPreview: () => <div>Preview</div> }))
import { ArtifactDetail } from "@/components/docs/artifact-detail"

const props = { workspaceId: "workspace", basePath: "/acme/product/docs", artifact: { id: "artifact", title: "Prototype", description: null, sourceType: "HTML_UPLOAD", status: "ARCHIVED", currentRevision: null, revisions: [] }, solutions: [], decisions: [{ id: "decision", title: "Choose layout", state: "DECIDED" }] }
beforeEach(() => vi.resetAllMocks())
afterEach(cleanup)

function openLinksTab() {
  fireEvent.click(screen.getByRole("button", { name: "Details" }))
  fireEvent.click(screen.getByRole("tab", { name: "Links" }))
}

it("shows a navigable reciprocal Decision in the Links tab without adding a second picker", () => {
  render(<ArtifactDetail {...props} />)
  expect(screen.getByText("This artifact is archived.")).toBeInTheDocument()
  openLinksTab()
  expect(screen.getByRole("heading", { name: "Linked decisions" })).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "Choose layout" })).toHaveAttribute("href", "/acme/product/reviews/decision")
  expect(screen.queryByRole("combobox", { name: /Decision/i })).toBeNull()
})
it("unlinks from the Artifact and refreshes", async () => {
  render(<ArtifactDetail {...props} />)
  openLinksTab()
  fireEvent.click(screen.getByRole("button", { name: "Unlink Choose layout" }))
  await waitFor(() => expect(mocks.unlink).toHaveBeenCalledWith("workspace", "artifact", "decision", "/acme/product/docs"))
  expect(mocks.refresh).toHaveBeenCalled()
})
