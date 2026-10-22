// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const mocks = vi.hoisted(() => ({
  create: vi.fn(), update: vi.fn(), remove: vi.fn(), refresh: vi.fn(),
}))

vi.mock("@/app/[orgSlug]/saved-views-actions", () => ({
  createSavedViewAction: mocks.create,
  updateSavedViewAction: mocks.update,
  deleteSavedViewAction: mocks.remove,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn(), replace: vi.fn() }) }))

import { SavedViewsMenu } from "@/components/saved-views/saved-views-menu"
import type { SavedViewRecord } from "@/lib/saved-views/service"

const WS = "11111111-1111-4111-8111-111111111111"

function view(over: Partial<SavedViewRecord> = {}): SavedViewRecord {
  return {
    id: "v1", name: "Mine", visibility: "PERSONAL", surface: "OPPORTUNITIES_BOARD", workspaceId: WS, ownerId: "u1",
    isOwner: true, canDelete: true, filters: { squadIds: [] }, display: { view: "board" }, updatedAt: "2026-01-01T00:00:00.000Z", ...over,
  }
}

const STATE = { filters: { squadIds: [] }, display: { view: "board", groupBy: "status", sort: "manual", columns: {} } }

function renderMenu(props: Partial<React.ComponentProps<typeof SavedViewsMenu>> = {}) {
  const onSelect = vi.fn()
  render(
    <SavedViewsMenu
      orgSlug="acme" surface="OPPORTUNITIES_BOARD" surfaceWorkspaceId={WS}
      views={[view(), view({ id: "v2", name: "Other" })]} savedViewId="v1" modified={false}
      state={STATE} canShare={true} extendedActions deleteNote="Cards are not affected." onSelect={onSelect}
      {...props}
    />,
  )
  return { onSelect }
}

describe("SavedViewsMenu", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it("lists the views and selects one", async () => {
    const { onSelect } = renderMenu({ savedViewId: null })
    fireEvent.click(screen.getByTestId("saved-views-trigger"))
    const options = await screen.findAllByTestId("saved-view-option")
    expect(options.map((o) => o.textContent)).toEqual(["Mine", "Other"])
    fireEvent.click(options[1])
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "v2" }))
  })

  it("shows the selected name, and Modified only when the live state differs", () => {
    renderMenu()
    expect(screen.getByTestId("saved-views-trigger")).toHaveTextContent("Mine")
    expect(screen.queryByTestId("saved-view-modified")).toBeNull()
    cleanup()
    renderMenu({ modified: true })
    expect(screen.getByTestId("saved-view-modified")).toHaveTextContent("Modified")
  })

  it("Save updates the selected view with the live state and the updatedAt it last saw", async () => {
    mocks.update.mockResolvedValue({ ok: true, view: view({ updatedAt: "2026-02-01T00:00:00.000Z" }) })
    const { onSelect } = renderMenu({ modified: true })
    fireEvent.click(screen.getByTestId("save-view-changes"))
    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    expect(mocks.update).toHaveBeenCalledWith(
      "acme", "OPPORTUNITIES_BOARD", WS, "v1",
      { name: "Mine", visibility: "PERSONAL", ...STATE },
      "2026-01-01T00:00:00.000Z",
    )
    await waitFor(() => expect(onSelect).toHaveBeenCalled())
  })

  it("surfaces an update conflict with a Reload action", async () => {
    mocks.update.mockResolvedValue({ ok: false, error: "This view was changed elsewhere. Reload to see the latest version.", code: "CONFLICT" })
    renderMenu({ modified: true })
    fireEvent.click(screen.getByTestId("save-view-changes"))
    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere")
    fireEvent.click(screen.getByTestId("reload-view"))
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it("Save as creates a new view from the live state and selects it", async () => {
    const created = view({ id: "v3", name: "Copy" })
    mocks.create.mockResolvedValue({ ok: true, view: created })
    const { onSelect } = renderMenu({ modified: true })
    fireEvent.click(screen.getByTestId("saved-views-trigger"))
    fireEvent.click(await screen.findByTestId("save-view-new"))
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Copy" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("acme", "OPPORTUNITIES_BOARD", WS, { name: "Copy", visibility: "PERSONAL", ...STATE }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(created))
  })

  it("shows a duplicate-name error from the server without closing the dialog", async () => {
    mocks.create.mockResolvedValue({ ok: false, error: "You already have a view with that name", code: "INVALID" })
    renderMenu({ savedViewId: null })
    fireEvent.click(screen.getByTestId("saved-views-trigger"))
    fireEvent.click(await screen.findByTestId("save-view-new"))
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Mine" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("already have a view")
    expect(screen.getByLabelText("Name")).toBeInTheDocument()
  })

  it("Reset re-selects the saved view, discarding edits", () => {
    const { onSelect } = renderMenu({ modified: true })
    fireEvent.click(screen.getByTestId("reset-view"))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "v1" }))
  })

  it("renames with the saved document, not the live edits", async () => {
    mocks.update.mockResolvedValue({ ok: true, view: view({ name: "Renamed" }) })
    renderMenu({ modified: true, state: { filters: { squadIds: ["x"] }, display: {} } })
    fireEvent.click(screen.getByRole("button", { name: "Edit view Mine" }))
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Renamed" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    expect(mocks.update).toHaveBeenCalledWith(
      "acme", "OPPORTUNITIES_BOARD", WS, "v1",
      { name: "Renamed", visibility: "PERSONAL", filters: { squadIds: [] }, display: { view: "board" } },
      "2026-01-01T00:00:00.000Z",
    )
  })

  it("deletes after confirmation and falls back to the default view", async () => {
    mocks.remove.mockResolvedValue({ ok: true })
    const { onSelect } = renderMenu()
    fireEvent.click(screen.getByRole("button", { name: "Delete view Mine" }))
    expect(await screen.findByText(/Cards are not affected\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("acme", "OPPORTUNITIES_BOARD", WS, "v1"))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null))
  })

  it("hides the Share toggle on a surface without sharing, and shows it where sharing exists", async () => {
    renderMenu({ savedViewId: null, canShare: true })
    fireEvent.click(screen.getByTestId("saved-views-trigger"))
    fireEvent.click(await screen.findByTestId("save-view-new"))
    await screen.findByLabelText("Name")
    expect(screen.queryByText("Share with everyone")).toBeNull()
    cleanup()
    renderMenu({ savedViewId: null, canShare: true, surface: "ROADMAP_WORKSPACE" })
    fireEvent.click(screen.getByTestId("saved-views-trigger"))
    fireEvent.click(await screen.findByTestId("save-view-new"))
    expect(await screen.findByText("Share with everyone")).toBeInTheDocument()
  })

  it("offers no way to save, rename or delete to a member who cannot save", async () => {
    renderMenu({ canSave: false, modified: true })
    expect(screen.queryByTestId("save-view-changes")).toBeNull()
    expect(screen.queryByRole("button", { name: "Edit view Mine" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Delete view Mine" })).toBeNull()
    fireEvent.click(screen.getByTestId("saved-views-trigger"))
    await screen.findAllByTestId("saved-view-option")
    expect(screen.queryByTestId("save-view-new")).toBeNull()
    // They can still reset local edits.
    expect(screen.getByTestId("reset-view")).toBeInTheDocument()
  })

  it("keeps the roadmap look: '(modified)' text and no Reset button", () => {
    renderMenu({ extendedActions: false, modified: true, surface: "ROADMAP_WORKSPACE" })
    expect(screen.getByTestId("saved-views-trigger")).toHaveTextContent("(modified)")
    expect(screen.queryByTestId("reset-view")).toBeNull()
  })
})
