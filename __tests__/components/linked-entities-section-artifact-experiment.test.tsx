// @vitest-environment jsdom
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const mocks = vi.hoisted(() => ({ read: vi.fn(), change: vi.fn() }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/links/actions", () => ({ readEntityLinks: mocks.read, changeEntityLink: mocks.change }))

import { LinkedEntitiesSection } from "@/components/links/linked-entities-section"

const view = (canLink: boolean) => ({
  linkType: "ARTIFACT_ATTACHED_TO_EXPERIMENT", side: "from", label: "Attached to", otherType: "EXPERIMENT", otherNoun: "experiment", otherNounPlural: "experiments",
  linked: [{ type: "EXPERIMENT", id: "exp-1", title: "Onboarding test", status: "RUNNING" }],
  candidates: [{ type: "EXPERIMENT", id: "exp-2", title: "Pricing test", status: "DESIGNING" }],
  canLink,
})
const target = { linkType: "ARTIFACT_ATTACHED_TO_EXPERIMENT", entityType: "ARTIFACT", entityId: "art-1" }

beforeEach(() => { vi.clearAllMocks(); mocks.change.mockResolvedValue({ ok: true, changed: true }) })
afterEach(cleanup)

describe("LinkedEntitiesSection for artifact -> experiment", () => {
  it("shows the title override as the heading and links each experiment to its page", async () => {
    mocks.read.mockResolvedValue({ ok: true, view: view(true) })
    render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
    expect(await screen.findByRole("heading", { name: "Linked experiments" })).toBeTruthy()
    expect(screen.getByRole("region", { name: "Linked experiments" })).toBeTruthy()
    const link = screen.getByRole("link", { name: "Onboarding test" })
    expect(link.getAttribute("href")).toBe("/acme/compass/experiments/exp-1")
    expect(screen.getByRole("button", { name: "Link existing experiment" })).toBeTruthy()
  })

  it("unlinks through changeEntityLink with the artifact as the viewed entity", async () => {
    mocks.read.mockResolvedValue({ ok: true, view: view(true) })
    render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
    fireEvent.click(await screen.findByRole("button", { name: "Unlink Onboarding test" }))
    await waitFor(() => expect(mocks.change).toHaveBeenCalledWith("acme", "compass", { ...target, otherId: "exp-1", operation: "unlink" }))
  })

  it("hides the add button for an artifact that cannot take a new link (archived) but keeps existing links removable", async () => {
    mocks.read.mockResolvedValue({ ok: true, view: view(false) })
    render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
    expect(await screen.findByRole("button", { name: "Unlink Onboarding test" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Link existing experiment" })).toBeNull()
  })

  it("renders nothing when the type does not apply, and falls back to the registry label without a title", async () => {
    mocks.read.mockResolvedValue({ ok: true, view: null })
    const { container, rerender } = render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
    await waitFor(() => expect(container.querySelector("section")).toBeNull())
    mocks.read.mockResolvedValue({ ok: true, view: view(true) })
    rerender(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={{ ...target, entityId: "art-2" }} />)
    expect(await screen.findByRole("heading", { name: "Attached to experiments" })).toBeTruthy()
  })

  it("reloads when refreshKey changes, so an artifact archived in place loses its add button without a page reload", async () => {
    mocks.read.mockResolvedValue({ ok: true, view: view(true) })
    const { rerender } = render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" refreshKey="ACTIVE" />)
    expect(await screen.findByRole("button", { name: "Link existing experiment" })).toBeTruthy()
    mocks.read.mockResolvedValue({ ok: true, view: view(false) })
    rerender(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" refreshKey="ARCHIVED" />)
    await waitFor(() => expect(screen.queryByRole("button", { name: "Link existing experiment" })).toBeNull())
    expect(screen.getByRole("button", { name: "Unlink Onboarding test" })).toBeTruthy()
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  describe("accessibility and interaction polish", () => {
    it("names the section by its heading (aria-labelledby), keeping the full name for registry-labelled sections", async () => {
      mocks.read.mockResolvedValue({ ok: true, view: view(true) })
      const { rerender } = render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
      const section = (await screen.findByRole("heading", { name: "Linked experiments" })).closest("section")!
      expect(section.hasAttribute("aria-label")).toBe(false)
      expect(section.getAttribute("aria-labelledby")).toBe(screen.getByRole("heading", { name: "Linked experiments" }).id)
      rerender(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={{ ...target, entityId: "art-9" }} />)
      // Without a title the accessible name is still "<label> <plural>" so existing selectors keep working.
      expect(await screen.findByRole("region", { name: "Attached to experiments" })).toBeTruthy()
    })

    it("uses plain helper copy", async () => {
      mocks.read.mockResolvedValue({ ok: true, view: view(true) })
      render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
      expect(await screen.findByText("Experiments linked to this record. Linking doesn't change either record.")).toBeTruthy()
    })

    it("gives every action at least a 44px touch target below the sm breakpoint", async () => {
      mocks.read.mockResolvedValue({ ok: true, view: view(true) })
      render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
      for (const name of ["Unlink Onboarding test", "Link existing experiment"]) {
        expect((await screen.findByRole("button", { name })).className).toContain("max-sm:min-h-11")
      }
    })

    it("keeps one status live region mounted from the first render, announcing loading then saving", async () => {
      let finish!: (value: unknown) => void
      mocks.read.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
      render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
      const status = screen.getByRole("status")
      expect(status.textContent).toBe("Loading links…")
      expect(screen.queryByText(/linked to this record/)).toBeNull() // no "Items…" placeholder copy while the noun is unknown
      finish({ ok: true, view: view(true) })
      await waitFor(() => expect(status.textContent).toBe(""))
      expect(screen.getByRole("status")).toBe(status) // the same node: never unmounted
      let release!: (value: unknown) => void
      mocks.change.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
      fireEvent.click(screen.getByRole("button", { name: "Unlink Onboarding test" }))
      await waitFor(() => expect(status.textContent).toBe("Saving link…"))
      release({ ok: true, changed: true })
      await waitFor(() => expect(status.textContent).toBe(""))
    })

    it("returns focus to the section heading after an unlink instead of dropping it to the page", async () => {
      mocks.read.mockResolvedValue({ ok: true, view: view(true) })
      render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
      const button = await screen.findByRole("button", { name: "Unlink Onboarding test" })
      mocks.read.mockResolvedValue({ ok: true, view: { ...view(true), linked: [] } })
      fireEvent.click(button)
      await waitFor(() => expect(screen.queryByRole("button", { name: "Unlink Onboarding test" })).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Linked experiments" })))
    })

    it("shows a failure once: in the section while the dialog is closed, in the dialog while it is open", async () => {
      mocks.read.mockResolvedValue({ ok: true, view: view(true) })
      mocks.change.mockResolvedValue({ ok: false, error: "Archived artifacts cannot be linked to an experiment." })
      render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
      fireEvent.click(await screen.findByRole("button", { name: "Unlink Onboarding test" }))
      expect((await screen.findAllByRole("alert")).length).toBe(1)
      const add = screen.getByRole("button", { name: "Link existing experiment" }) as HTMLButtonElement
      await waitFor(() => expect(add.disabled).toBe(false)) // the failed unlink's transition is still settling
      fireEvent.click(add)
      await screen.findByRole("dialog")
      // Count in the DOM (a modal hides the page behind it from role queries, which would hide the duplicate).
      expect(document.querySelectorAll('[role="alert"]').length).toBe(1)
      expect(screen.getByRole("dialog").querySelectorAll('[role="alert"]').length).toBe(1)
    })

    it("tells rows with the same title apart in their Unlink names", async () => {
      const twin = { type: "EXPERIMENT", title: "Pricing test", status: "RUNNING" }
      mocks.read.mockResolvedValue({ ok: true, view: { ...view(true), linked: [{ ...twin, id: "aaaaaaaa-1111" }, { ...twin, id: "bbbbbbbb-2222" }] } })
      render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
      const names = (await screen.findAllByRole("button", { name: /^Unlink Pricing test/ })).map((b) => b.getAttribute("aria-label"))
      expect(new Set(names).size).toBe(2)
    })

    it("does not blank the section while it reloads for a new refreshKey", async () => {
      mocks.read.mockResolvedValue({ ok: true, view: view(true) })
      const { rerender } = render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" refreshKey="ACTIVE" />)
      await screen.findByRole("link", { name: "Onboarding test" })
      mocks.read.mockReturnValue(new Promise(() => {}))
      rerender(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" refreshKey="ARCHIVED" />)
      expect(screen.getByRole("link", { name: "Onboarding test" })).toBeTruthy()
      expect(screen.getByRole("status").textContent).toBe("")
    })

    it("does not fire a second read just because the dialog opened", async () => {
      mocks.read.mockResolvedValue({ ok: true, view: view(true) })
      render(<LinkedEntitiesSection orgSlug="acme" workspaceSlug="compass" target={target} title="Linked experiments" />)
      fireEvent.click(await screen.findByRole("button", { name: "Link existing experiment" }))
      await screen.findByRole("dialog")
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(mocks.read).toHaveBeenCalledTimes(1)
    })
  })
})
