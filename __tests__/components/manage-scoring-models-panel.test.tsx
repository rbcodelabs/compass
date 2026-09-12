// @vitest-environment jsdom
//
// Covers the client half of the scoring-model error fix:
//   • a new metric's minValue defaults sensibly for the selected formula
//   • switching to MULTIPLICATIVE re-bases only the invalid 0, never a value
//     the user deliberately typed
//   • the common mistakes are caught before the action is called at all
//   • a failure returned by the action is rendered instead of being swallowed
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({
  createScoringModel: vi.fn(),
  updateScoringModelDetails: vi.fn(),
  updateScoringModelMetrics: vi.fn(),
  archiveScoringModel: vi.fn(),
}))

vi.mock("@/app/[orgSlug]/settings/actions", () => actions)

import { ManageScoringModelsPanel } from "@/components/scoring-models/manage-scoring-models-panel"

function openCreateForm() {
  render(<ManageScoringModelsPanel orgSlug="acme" initialModels={[]} />)
  fireEvent.click(screen.getByRole("button", { name: /Add scoring model/i }))
}

/** The Min input of the nth metric row in the create form. */
function minInput(index = 0) {
  return document.querySelector(`#create-metric-${index}-min`) as HTMLInputElement
}
function keyInput(index = 0) {
  return document.querySelector(`#create-metric-${index}-key`) as HTMLInputElement
}
function labelInput(index = 0) {
  return document.querySelector(`#create-metric-${index}-label`) as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
  actions.createScoringModel.mockResolvedValue({ ok: true, model: { id: "model-1", version: 1 } })
})

afterEach(() => cleanup())

describe("create form — metric minValue defaults", () => {
  it("defaults a new metric's minValue to 0 under WEIGHTED_SUM", () => {
    openCreateForm()
    expect(minInput()).toHaveValue(0)
  })

  it("adds further metric rows at the WEIGHTED_SUM default too", () => {
    openCreateForm()
    fireEvent.click(screen.getByRole("button", { name: /Add metric/i }))
    expect(minInput(1)).toHaveValue(0)
  })
})

describe("create form — client-side validation runs before the action", () => {
  it("blocks submit and names the offending key on duplicate metric keys", async () => {
    openCreateForm()

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "RICE" } })
    fireEvent.change(keyInput(0), { target: { value: "reach" } })
    fireEvent.change(labelInput(0), { target: { value: "Reach" } })

    fireEvent.click(screen.getByRole("button", { name: /Add metric/i }))
    fireEvent.change(keyInput(1), { target: { value: "reach" } })
    fireEvent.change(labelInput(1), { target: { value: "Reach Again" } })

    fireEvent.click(screen.getByRole("button", { name: /Create Scoring Model/i }))

    const message = await screen.findAllByText(/Duplicate metric key "reach"/)
    expect(message.length).toBeGreaterThan(0)
    // Never round-tripped: the action was not called at all.
    expect(actions.createScoringModel).not.toHaveBeenCalled()
  })

  it("marks the offending key field invalid, not just the banner", async () => {
    openCreateForm()

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "RICE" } })
    fireEvent.change(keyInput(0), { target: { value: "reach" } })
    fireEvent.change(labelInput(0), { target: { value: "Reach" } })
    fireEvent.click(screen.getByRole("button", { name: /Add metric/i }))
    fireEvent.change(keyInput(1), { target: { value: "reach" } })
    fireEvent.change(labelInput(1), { target: { value: "Dup" } })

    fireEvent.click(screen.getByRole("button", { name: /Create Scoring Model/i }))

    await waitFor(() => expect(keyInput(1)).toHaveAttribute("aria-invalid", "true"))
    expect(keyInput(0)).not.toHaveAttribute("aria-invalid")
    expect(keyInput(1)).toHaveAttribute("aria-describedby", "create-metric-1-key-error")
  })

  it("submits a valid model through to the action", async () => {
    openCreateForm()

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "RICE" } })
    fireEvent.change(keyInput(0), { target: { value: "reach" } })
    fireEvent.change(labelInput(0), { target: { value: "Reach" } })

    fireEvent.click(screen.getByRole("button", { name: /Create Scoring Model/i }))

    await waitFor(() => expect(actions.createScoringModel).toHaveBeenCalledTimes(1))
    expect(actions.createScoringModel).toHaveBeenCalledWith("acme", {
      name: "RICE",
      description: undefined,
      formulaType: "WEIGHTED_SUM",
      metrics: [expect.objectContaining({ key: "reach", label: "Reach" })],
    })
    // Let the transition settle before the test ends, so cleanup never tears
    // the tree down mid-transition.
    await screen.findByRole("button", { name: /Add scoring model/i })
  })
})

describe("create form — failures returned by the action are rendered", () => {
  it("shows the action's error text rather than discarding it", async () => {
    actions.createScoringModel.mockResolvedValue({
      ok: false,
      error: "Forbidden: organization admin required",
    })
    openCreateForm()

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "RICE" } })
    fireEvent.change(keyInput(0), { target: { value: "reach" } })
    fireEvent.change(labelInput(0), { target: { value: "Reach" } })
    fireEvent.click(screen.getByRole("button", { name: /Create Scoring Model/i }))

    expect(await screen.findByText("Forbidden: organization admin required")).toBeVisible()

    // `setError` runs inside the async `startTransition` scope, so React can
    // commit the error while `isPending` is still true — and in that commit
    // the submit button reads "Creating...", not "Create Scoring Model".
    // Awaiting the idle label (rather than querying for it synchronously)
    // pins the state this assertion is actually about: the form is open,
    // settled and usable again.
    const submit = await screen.findByRole("button", { name: "Create Scoring Model" })
    expect(submit).toBeEnabled()
    // ...and the error is still on screen once the transition has settled,
    // i.e. it was not a transient flash that the settle wiped out.
    expect(screen.getByText("Forbidden: organization admin required")).toBeVisible()
  })

  it("disables and relabels the submit button while in flight, then restores it with the error", async () => {
    // Holds the action open so the pending window is deterministic instead of
    // a timing accident. This is the exact state a slow CI runner observed:
    // inputs disabled and *no* "Create Scoring Model" button, because it is
    // relabelled. Any assertion querying the submit button by its idle name
    // must therefore await the settle.
    let settleAction!: (result: unknown) => void
    actions.createScoringModel.mockReturnValue(
      new Promise((resolve) => {
        settleAction = resolve
      })
    )
    openCreateForm()

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "RICE" } })
    fireEvent.change(keyInput(0), { target: { value: "reach" } })
    fireEvent.change(labelInput(0), { target: { value: "Reach" } })
    fireEvent.click(screen.getByRole("button", { name: /Create Scoring Model/i }))

    const pending = await screen.findByRole("button", { name: "Creating..." })
    expect(pending).toBeDisabled()
    expect(screen.getByLabelText("Name")).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Create Scoring Model" })).toBeNull()

    await act(async () => {
      settleAction({ ok: false, error: "Forbidden: organization admin required" })
    })

    expect(await screen.findByText("Forbidden: organization admin required")).toBeVisible()
    const restored = await screen.findByRole("button", { name: "Create Scoring Model" })
    expect(restored).toBeEnabled()
    expect(screen.getByLabelText("Name")).toBeEnabled()
  })

  it("surfaces a server-returned issue at its own field", async () => {
    actions.createScoringModel.mockResolvedValue({
      ok: false,
      error: 'Metric "reach" must have a minValue greater than 0 for MULTIPLICATIVE formulas.',
      issues: [
        {
          index: 0,
          field: "minValue" as const,
          metricKey: "reach",
          message:
            'Metric "reach" must have a minValue greater than 0 for MULTIPLICATIVE formulas.',
        },
      ],
    })
    openCreateForm()

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "RICE" } })
    fireEvent.change(keyInput(0), { target: { value: "reach" } })
    fireEvent.change(labelInput(0), { target: { value: "Reach" } })
    fireEvent.click(screen.getByRole("button", { name: /Create Scoring Model/i }))

    // Await the settled form before reading the field, so this never inspects
    // a half-committed pending render.
    await screen.findByRole("button", { name: "Create Scoring Model" })
    expect(minInput(0)).toHaveAttribute("aria-invalid", "true")
    expect(minInput(0)).toHaveAttribute("aria-describedby", "create-metric-0-min-error")
  })

  it("closes the form and reports the new model on success", async () => {
    openCreateForm()

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "RICE" } })
    fireEvent.change(keyInput(0), { target: { value: "reach" } })
    fireEvent.change(labelInput(0), { target: { value: "Reach" } })
    fireEvent.click(screen.getByRole("button", { name: /Create Scoring Model/i }))

    // Waiting for the submit button to *disappear* would be a false pass: it
    // is also absent mid-transition, when it reads "Creating...". The
    // collapsed "Add scoring model" button only renders when the form is
    // genuinely closed, so that is what this waits for.
    expect(await screen.findByRole("button", { name: /Add scoring model/i })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Create Scoring Model" })).toBeNull()
    expect(screen.getByText("RICE")).toBeVisible()
  })
})

// The formula picker itself is a Base UI Select and is not reliably drivable
// in jsdom. The rules it triggers are pure and live in lib/scoring.ts, where
// they are tested directly (defaultMinValueForFormula /
// rebaseMinValuesForFormula in __tests__/lib/scoring.test.ts); the wiring
// between the two was verified against a production build in the QA run.
