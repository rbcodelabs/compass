// @vitest-environment jsdom
import React from "react"
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
const m = vi.hoisted(() => ({ read: vi.fn(), change: vi.fn() }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/experiments/research-actions", () => ({ readExperimentStudyLinks: m.read, changeExperimentStudyLink: m.change }))
// Reproduce Base UI's documented event boundary: selecting an item and then
// unmounting its search popup emits a programmatic input-clear event.
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ onValueChange, onInputValueChange, children }: { onValueChange: (id: string) => void; onInputValueChange: (value: string, details: { reason: string }) => void; children: React.ReactNode }) => <div>
    <button type="button" onClick={() => onValueChange("study")}>Choose study result</button>
    <button type="button" onClick={() => onInputValueChange("", { reason: "input-clear" })}>Close search popup</button>
    <button type="button" onClick={() => onInputValueChange("Different name", { reason: "input-change" })}>Search another name</button>
    {children}
  </div>,
  ComboboxTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComboboxValue: () => null,
  ComboboxContent: () => null,
}))
import { ExperimentResearchLinksSection } from "@/components/research/experiment-research-links-section"
afterEach(cleanup)
it("preserves a selected result when its popup clears, but invalidates it on a new user search", async () => {
  m.read.mockResolvedValue({ linked: [], available: [{ id: "study", title: "Study", status: "DRAFT" }], canLink: true })
  render(<ExperimentResearchLinksSection orgSlug="org" workspaceSlug="workspace" target={{ type: "experiment", id: "experiment" }} />)
  fireEvent.click(await screen.findByRole("button", { name: "Link existing study" }))
  fireEvent.click(screen.getByRole("button", { name: "Choose study result" }))
  fireEvent.click(screen.getByRole("button", { name: "Close search popup" }))
  const submit = screen.getByRole("button", { name: "Link study" }) as HTMLButtonElement
  await waitFor(() => expect(submit.disabled).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "Search another name" }))
  expect(submit.disabled).toBe(true)
})
