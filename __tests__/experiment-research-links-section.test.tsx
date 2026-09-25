// @vitest-environment jsdom
import React from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
const m = vi.hoisted(() => ({ read: vi.fn(), change: vi.fn() }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/experiments/research-actions", () => ({ readExperimentStudyLinks: m.read, changeExperimentStudyLink: m.change }))
import { ExperimentResearchLinksSection } from "@/components/research/experiment-research-links-section"
const props = { orgSlug: "org", workspaceSlug: "workspace", target: { type: "experiment" as const, id: "experiment" } }
beforeEach(() => { vi.resetAllMocks(); m.read.mockResolvedValue({ linked: [], available: [], canLink: true }) })
afterEach(cleanup)
it("loads an empty section with its link control", async () => {
  render(<ExperimentResearchLinksSection {...props} />)
  expect(screen.getByText("Loading links…")).toBeDefined()
  expect(await screen.findByText("No research studies linked yet.")).toBeDefined()
  expect(screen.getByRole("button", { name: "Link existing study" })).toBeDefined()
})
it("keeps archived navigation and allows unlink with a refreshed section", async () => {
  m.read.mockResolvedValue({ linked: [{ id: "study", title: "Archived study", status: "ARCHIVED" }], available: [], canLink: true })
  render(<ExperimentResearchLinksSection {...props} />)
  expect((await screen.findByRole("link", { name: "Archived study" })).getAttribute("href")).toBe("/org/workspace/capture/studies/study")
  expect(screen.getByText("Archived")).toBeDefined()
  fireEvent.click(screen.getByRole("button", { name: "Unlink Archived study" }))
  await waitFor(() => expect(m.change).toHaveBeenCalledWith("org", "workspace", "experiment", "study", "unlink"))
  await waitFor(() => expect(m.read).toHaveBeenCalledTimes(2))
})
it("shows recoverable fetch errors without exposing server details", async () => {
  m.read.mockRejectedValueOnce(new Error("private database details"))
  render(<ExperimentResearchLinksSection {...props} />)
  expect(await screen.findByRole("alert")).toBeDefined()
  expect(screen.queryByText(/private database/)).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  expect(await screen.findByText("No research studies linked yet.")).toBeDefined()
})
it("does not offer linking from an archived study", async () => {
  m.read.mockResolvedValue({ linked: [], available: [], canLink: false })
  render(<ExperimentResearchLinksSection {...props} target={{ type: "study", id: "study" }} />)
  await screen.findByText("No experiments linked yet.")
  expect(screen.queryByRole("button", { name: "Link existing experiment" })).toBeNull()
})
