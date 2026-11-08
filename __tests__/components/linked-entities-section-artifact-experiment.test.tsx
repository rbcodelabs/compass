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
    expect(await screen.findByRole("heading", { name: "Attached to" })).toBeTruthy()
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
})
