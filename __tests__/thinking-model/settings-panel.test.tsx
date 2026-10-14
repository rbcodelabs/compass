// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

const updateThinkingModel = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, thinkingModel: "CLASSIC" })))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/thinking-model-actions", () => ({ updateThinkingModel }))

import { REMAINING_CANONICAL_SURFACES, remainingCanonicalNotice } from "@/lib/thinking-model/canonical-surfaces"
import { ThinkingModelPanel } from "@/components/settings/thinking-model-panel"

afterEach(() => {
  cleanup()
  updateThinkingModel.mockClear()
})

const base = { orgSlug: "acme", workspaceSlug: "alpha", initialKey: "CLASSIC" as const, initialOverrides: {} }

describe("ThinkingModelPanel", () => {
  it("offers every shipped preset and a name field pair for each of the five entities", () => {
    render(<ThinkingModelPanel {...base} />)
    expect(screen.getByTestId("thinking-model-CLASSIC")).toBeInTheDocument()
    expect(screen.getByTestId("thinking-model-TORRES_OST")).toBeInTheDocument()
    expect(screen.getByTestId("thinking-model-OPPORTUNITY_FIRST_OKR")).toBeInTheDocument()
    expect(screen.getByLabelText("Objective (singular)")).toBeInTheDocument()
    expect(screen.getByLabelText("Key Result (plural)")).toBeInTheDocument()
    for (const entity of ["Opportunity", "Solution", "Cycle"]) {
      expect(screen.getByLabelText(`${entity} (singular)`)).toBeInTheDocument()
      expect(screen.getByLabelText(`${entity} (plural)`)).toBeInTheDocument()
    }
  })

  it("describes what each non-classic preset adds, as it ships", () => {
    render(<ThinkingModelPanel {...base} />)
    const torres = screen.getByTestId("thinking-model-TORRES_OST").closest("label")!.textContent ?? ""
    expect(torres).toContain("outcome tree")
    expect(torres).toContain("flat list of all outcomes")
    expect(torres).toContain("still belong to a cycle")
    const first = screen.getByTestId("thinking-model-OPPORTUNITY_FIRST_OKR").closest("label")!.textContent ?? ""
    expect(first).toContain("pool of opportunities")
    expect(first).toContain("link an opportunity")
  })

  it("the notice lists exactly the remaining canonical surfaces, from the one shared list", () => {
    render(<ThinkingModelPanel {...base} />)
    const notice = screen.getByTestId("thinking-model-notice").textContent ?? ""
    expect(notice).toBe(remainingCanonicalNotice())
    for (const surface of REMAINING_CANONICAL_SURFACES) expect(notice).toContain(surface.summary)
    // The surfaces that are converted are no longer claimed to be canonical.
    for (const word of ["canvas", "discovery board", "panels", "measurements"]) expect(notice).not.toContain(word)
  })

  it("saves a rename of a Solution and a Cycle", async () => {
    render(<ThinkingModelPanel {...base} />)
    fireEvent.change(screen.getByLabelText("Solution (singular)"), { target: { value: "Bet" } })
    fireEvent.change(screen.getByLabelText("Cycle (singular)"), { target: { value: "Sprint" } })
    fireEvent.click(screen.getByTestId("thinking-model-save"))
    await vi.waitFor(() => expect(updateThinkingModel).toHaveBeenCalledTimes(1))
    expect(updateThinkingModel).toHaveBeenCalledWith("acme", "alpha", {
      thinkingModel: "CLASSIC",
      labels: { solution: { singular: "Bet" }, cycle: { singular: "Sprint" } },
    })
  })

  it("shows the stored preset as selected", () => {
    render(<ThinkingModelPanel {...base} initialKey="OPPORTUNITY_FIRST_OKR" />)
    expect(screen.getByTestId("thinking-model-OPPORTUNITY_FIRST_OKR")).toBeChecked()
  })

  it("no warning and a usable Save when everything stored is applied", () => {
    render(<ThinkingModelPanel {...base} initialOverrides={{ objective: { singular: "Goal" } }} />)
    expect(screen.queryByTestId("thinking-model-unapplied")).toBeNull()
    expect(screen.getByLabelText("Objective (singular)")).toHaveValue("Goal")
    expect(screen.getByTestId("thinking-model-save")).toBeEnabled()
  })

  it("stored-but-unapplied names are shown, not silently overwritten", () => {
    const raw = '{"solution":{"singular":"Bet"},"roadmapItem":{"singular":"X"}}'
    render(<ThinkingModelPanel {...base} unappliedStored={raw} />)
    const alert = screen.getByTestId("thinking-model-unapplied")
    expect(alert).toHaveTextContent(raw)
    expect(alert).toHaveTextContent("not being used")
    // The empty form cannot be saved over them without an explicit choice.
    expect(screen.getByTestId("thinking-model-save")).toBeDisabled()
    fireEvent.click(screen.getByTestId("thinking-model-save"))
    expect(updateThinkingModel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("thinking-model-replace-stored"))
    expect(screen.getByTestId("thinking-model-save")).toBeEnabled()
    fireEvent.click(screen.getByTestId("thinking-model-save"))
    expect(updateThinkingModel).toHaveBeenCalledTimes(1)
  })
})
