// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ unlink: vi.fn(), refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ unlinkArtifactDecision: mocks.unlink }))
vi.mock("@/components/docs/artifact-preview", () => ({ ArtifactPreview: () => <div>Preview</div> }))
import { ArtifactDetail } from "@/components/docs/artifact-detail"

const props = { workspaceId: "workspace", basePath: "/acme/product/docs", artifact: { id: "artifact", title: "Prototype", description: null, sourceType: "HTML_UPLOAD", status: "ARCHIVED", currentRevision: null, revisions: [] }, solutions: [], decisions: [{ id: "decision", title: "Choose layout", state: "DECIDED" }] }
beforeEach(() => vi.resetAllMocks())
afterEach(cleanup)
it("shows a navigable reciprocal Decision without adding a second picker", () => {
  render(<ArtifactDetail {...props} />)
  expect(screen.getByRole("heading", { name: "Linked decisions" })).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "Choose layout" })).toHaveAttribute("href", "/acme/product/reviews/decision")
  expect(screen.queryByRole("combobox", { name: /Decision/i })).toBeNull()
})
it("unlinks from the Artifact and refreshes", async () => {
  render(<ArtifactDetail {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "Unlink Choose layout" }))
  await waitFor(() => expect(mocks.unlink).toHaveBeenCalledWith("workspace", "artifact", "decision", "/acme/product/docs"))
  expect(mocks.refresh).toHaveBeenCalled()
})
