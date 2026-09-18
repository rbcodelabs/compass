// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

/**
 * Base UI's SelectItem only commits a mouse click when a `pointerdown` primed
 * `allowMouseSelectionRef` first (see SelectItem.js's onClick guard against
 * `isInvalidMouseClick`) — a real browser always fires pointerdown before
 * click, but jsdom's fireEvent.click alone does not, so the plain click is
 * silently ignored and the popup stays open. Fire both, like a real pointer.
 */
function selectOption(option: HTMLElement) {
  fireEvent.pointerDown(option, { pointerType: "mouse" })
  fireEvent.click(option)
}
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StudyBuilder } from "@/components/research/study-builder"

afterEach(cleanup)

describe("StudyBuilder", () => {
  it("preserves customer interviews and reveals the complete guided UX setup", () => {
    render(<StudyBuilder action={vi.fn()} generateGuide={vi.fn()} />)
    expect(screen.getByText("Discussion guide")).toBeVisible()
    expect(screen.queryByLabelText("Live product URL")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Target duration")).toHaveValue("15")
    expect(screen.getByRole("button", { name: "Generate questions with Compass" })).toBeEnabled()

    fireEvent.click(screen.getByRole("radio", { name: "Guided usability test" }))

    expect(screen.getByLabelText("Live product URL")).toBeRequired()
    expect(screen.getByLabelText("Target duration")).toHaveValue("15")
    expect(screen.getByRole("button", { name: "Generate tasks with Compass" })).toBeEnabled()
    expect(screen.getByText(/editable tasks/i)).toBeVisible()
  })

  it("loads generated tasks into editable inputs that can be added or removed", async () => {
    const generateTasks = vi.fn().mockResolvedValue([
      "Task one", "Task two", "Task three", "Task four", "Task five",
    ])
    render(<StudyBuilder action={vi.fn()} generateGuide={generateTasks} />)
    fireEvent.click(screen.getByRole("radio", { name: "Guided usability test" }))
    fireEvent.change(screen.getByLabelText("What are you trying to learn?"), { target: { value: "Learn navigation" } })
    fireEvent.change(screen.getByLabelText("Live product URL"), { target: { value: "https://example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Generate tasks with Compass" }))

    expect(await screen.findByDisplayValue("Task five")).toBeVisible()
    expect(screen.getAllByRole("textbox", { name: /Task \d/ })).toHaveLength(5)
    expect(generateTasks).toHaveBeenCalledWith(expect.objectContaining({ studyType: "USABILITY_TEST" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove task 2" }))
    expect(screen.queryByDisplayValue("Task two")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Add task" }))
    expect(screen.getAllByRole("textbox", { name: /Task \d/ })).toHaveLength(5)
  })

  it("loads generated customer-interview questions into editable inputs", async () => {
    const generateGuide = vi.fn().mockResolvedValue([
      "Question one", "Question two", "Question three", "Question four", "Question five",
    ])
    render(<StudyBuilder action={vi.fn()} generateGuide={generateGuide} />)
    fireEvent.change(screen.getByLabelText("What are you trying to learn?"), { target: { value: "Learn current behavior" } })
    fireEvent.click(screen.getByRole("button", { name: "Generate questions with Compass" }))

    expect(await screen.findByDisplayValue("Question five")).toBeVisible()
    expect(generateGuide).toHaveBeenCalledWith(expect.objectContaining({
      studyType: "CUSTOMER_INTERVIEW", appUrl: "", targetMinutes: 15,
    }))
  })

  describe("artifact target mode", () => {
    const artifacts = [
      { id: "artifact-1", title: "Onboarding prototype" },
      { id: "artifact-2", title: "Checkout prototype" },
    ]

    it("only offers the target-mode toggle once the guided usability test type is chosen", () => {
      render(<StudyBuilder action={vi.fn()} generateGuide={vi.fn()} artifacts={artifacts} />)
      expect(screen.queryByRole("radio", { name: "External URL" })).not.toBeInTheDocument()
      expect(screen.queryByRole("radio", { name: "Compass Artifact" })).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole("radio", { name: "Guided usability test" }))

      expect(screen.getByRole("radio", { name: "External URL" })).toBeChecked()
      expect(screen.getByRole("radio", { name: "Compass Artifact" })).not.toBeChecked()
      expect(screen.getByLabelText("Live product URL")).toBeInTheDocument()
    })

    it("swaps the URL input for an artifact picker and submits artifactId instead of appUrl", async () => {
      render(<StudyBuilder action={vi.fn()} generateGuide={vi.fn()} artifacts={artifacts} />)
      fireEvent.click(screen.getByRole("radio", { name: "Guided usability test" }))
      fireEvent.click(screen.getByRole("radio", { name: "Compass Artifact" }))

      expect(screen.queryByLabelText("Live product URL")).not.toBeInTheDocument()
      expect(screen.getByLabelText("Artifact to test")).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText("Artifact to test"))
      selectOption(await screen.findByRole("option", { name: "Checkout prototype" }))

      const hiddenInput = document.querySelector('input[name="artifactId"]') as HTMLInputElement
      await waitFor(() => expect(hiddenInput.value).toBe("artifact-2"))
      expect(document.querySelector('input[name="appUrl"]')).not.toBeInTheDocument()
    })

    it("passes the selected artifact's title, not appUrl, to guide generation", async () => {
      const generateGuide = vi.fn().mockResolvedValue(["A", "B", "C", "D", "E"])
      render(<StudyBuilder action={vi.fn()} generateGuide={generateGuide} artifacts={artifacts} />)
      fireEvent.click(screen.getByRole("radio", { name: "Guided usability test" }))
      fireEvent.click(screen.getByRole("radio", { name: "Compass Artifact" }))
      fireEvent.click(screen.getByLabelText("Artifact to test"))
      selectOption(screen.getByRole("option", { name: "Onboarding prototype" }))
      fireEvent.click(screen.getByRole("button", { name: "Generate tasks with Compass" }))

      await screen.findByDisplayValue("E")
      expect(generateGuide).toHaveBeenCalledWith(expect.objectContaining({
        studyType: "USABILITY_TEST", artifactTitle: "Onboarding prototype",
      }))
      expect(generateGuide.mock.calls[0][0]).not.toHaveProperty("appUrl")
    })
  })
})
