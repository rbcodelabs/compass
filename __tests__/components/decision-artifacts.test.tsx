// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ link: vi.fn(), unlink: vi.fn(), refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ linkArtifactDecision: mocks.link, unlinkArtifactDecision: mocks.unlink }))
import { DecisionArtifacts } from "@/components/decisions/decision-artifacts"

const props = { workspaceId: "workspace", requestId: "decision", basePath: "/acme/product/docs", canEdit: true, artifacts: [{ id: "linked", title: "Existing prototype", status: "ARCHIVED", currentRevision: { revisionNumber: 3 } }], availableArtifacts: [{ id: "new", title: "New prototype" }] }
beforeEach(() => vi.resetAllMocks())
afterEach(cleanup)
it("renders live supporting material, current revision and archive status", () => {
  render(<DecisionArtifacts {...props} />)
  expect(screen.getByRole("link", { name: /Existing prototype/ })).toHaveAttribute("href", "/acme/product/docs/artifacts/linked")
  expect(screen.getByText(/Revision 3/)).toBeInTheDocument()
  expect(screen.getByText("Archived")).toBeInTheDocument()
  expect(screen.getByText(/not frozen approval evidence/)).toBeInTheDocument()
  expect(screen.queryByRole("option", { name: "Existing prototype" })).toBeNull()
})
it("links through an accessible selector then refreshes", async () => {
  render(<DecisionArtifacts {...props} />)
  fireEvent.change(screen.getByRole("combobox", { name: "Artifact to link" }), { target: { value: "new" } })
  fireEvent.click(screen.getByRole("button", { name: "Link" }))
  await waitFor(() => expect(mocks.link).toHaveBeenCalledWith("workspace", "new", "decision", "/acme/product/docs"))
  expect(mocks.refresh).toHaveBeenCalled()
})
it("allows archived unlink and reports errors without refreshing", async () => {
  mocks.unlink.mockRejectedValue(new Error("Access denied"))
  render(<DecisionArtifacts {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "Unlink Existing prototype" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Access denied")
  expect(mocks.refresh).not.toHaveBeenCalled()
})
it("keeps links visible but hides all editing for read-only Decision viewers", () => {
  render(<DecisionArtifacts {...props} canEdit={false} />)
  expect(screen.getByRole("link", { name: /Existing prototype/ })).toBeInTheDocument()
  expect(screen.queryByRole("button")).toBeNull()
  expect(screen.queryByRole("combobox")).toBeNull()
})
it("disables controls while a request is pending", async () => {
  let finish!: () => void
  mocks.unlink.mockReturnValue(new Promise<void>((resolve) => { finish = resolve }))
  render(<DecisionArtifacts {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "Unlink Existing prototype" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Unlink Existing prototype" })).toBeDisabled())
  expect(screen.getByRole("combobox")).toBeDisabled()
  finish()
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
})
it("shows a useful empty state when no active Artifacts are available", () => {
  render(<DecisionArtifacts {...props} artifacts={[]} availableArtifacts={[]} />)
  expect(screen.getByText(/No supporting Artifacts linked/)).toBeInTheDocument()
  expect(screen.getByRole("link", { name: /Create an Artifact/ })).toHaveAttribute("href", "/acme/product/docs/artifacts/new")
})
