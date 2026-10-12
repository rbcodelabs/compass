// @vitest-environment jsdom

import { createElement } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ createArtifact: vi.fn() }))

import { ArtifactCreateForm } from "@/components/docs/artifact-create-form"

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
