// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StudyBuilder } from "@/components/research/study-builder"

afterEach(cleanup)

describe("StudyBuilder", () => {
  it("preserves customer interviews and reveals the complete guided UX setup", () => {
    render(<StudyBuilder action={vi.fn()} generateTasks={vi.fn()} />)
    expect(screen.getByText("Discussion guide")).toBeVisible()
    expect(screen.queryByLabelText("Live product URL")).not.toBeInTheDocument()

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
    render(<StudyBuilder action={vi.fn()} generateTasks={generateTasks} />)
    fireEvent.click(screen.getByRole("radio", { name: "Guided usability test" }))
    fireEvent.change(screen.getByLabelText("What are you trying to learn?"), { target: { value: "Learn navigation" } })
    fireEvent.change(screen.getByLabelText("Live product URL"), { target: { value: "https://example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Generate tasks with Compass" }))

    expect(await screen.findByDisplayValue("Task five")).toBeVisible()
    expect(screen.getAllByRole("textbox", { name: /Task \d/ })).toHaveLength(5)
    fireEvent.click(screen.getByRole("button", { name: "Remove task 2" }))
    expect(screen.queryByDisplayValue("Task two")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Add task" }))
    expect(screen.getAllByRole("textbox", { name: /Task \d/ })).toHaveLength(5)
  })
})
