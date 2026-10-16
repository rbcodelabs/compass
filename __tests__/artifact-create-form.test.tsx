// @vitest-environment jsdom

import { createElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ createArtifact: vi.fn() }))

import { ArtifactCreateForm } from "@/components/docs/artifact-create-form"
import { createArtifact } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"

afterEach(cleanup)

const renderForm = () => render(createElement(ArtifactCreateForm, { workspaceId: "ws-1", basePath: "/acme/product/docs" }))

describe("ArtifactCreateForm source toggle", () => {
  it("opens the file picker when Upload HTML is clicked while already selected", () => {
    const { container } = renderForm()
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const click = vi.spyOn(fileInput, "click")
    fireEvent.click(screen.getByRole("button", { name: "Upload HTML" }))
    expect(click).toHaveBeenCalledTimes(1)
  })

  it("switches to External link and back without opening the picker", () => {
    const { container } = renderForm()
    fireEvent.click(screen.getByRole("button", { name: "External link" }))
    expect(container.querySelector('input[type="file"]')).toBeNull()
    expect(screen.getByRole("button", { name: "External link" })).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: "Upload HTML" }))
    expect(container.querySelector('input[type="file"]')).not.toBeNull()
    expect(screen.getByRole("checkbox", { name: /slide deck/i })).toBeInTheDocument()
  })
})

describe("ArtifactCreateForm v0 failures", () => {
  it("shows an error returned by the server action instead of navigating", async () => {
    vi.mocked(createArtifact).mockResolvedValueOnce({ error: "That is not a v0 chat URL. Expected https://v0.app/chat/<id>" })
    const { container } = renderForm()
    fireEvent.click(screen.getByRole("button", { name: "v0 chat" }))
    fireEvent.change(container.querySelector<HTMLInputElement>('input[name="url"]')!, { target: { value: "https://v0.app/nope" } })
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(screen.getByText(/not a v0 chat URL/)).toBeInTheDocument())
  })
})
