// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CloudAgentFields, EMPTY_CLOUD_AGENT_VALUES, type CloudAgentFormValues } from "@/components/settings/cloud-agent-form"
import { matchesModelQuery } from "@/components/settings/model-catalog-picker"

const models = [
  { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { value: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5 (AI Gateway)" },
  { value: "anthropic/claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
  { value: "openai/gpt-5", label: "GPT-5", provider: "openai" },
  { value: "openai/gpt-5-mini", label: "GPT-5 Mini", provider: "openai" },
  { value: "google/gemini-3", label: "Gemini 3", provider: "google" },
]

function Harness({ initial = "", onValue, ui }: { initial?: string; onValue?: (v: string) => void; ui: { searchable?: boolean; note?: string | null } }) {
  const [values, setValues] = useState<CloudAgentFormValues>({ ...EMPTY_CLOUD_AGENT_VALUES, name: "A", model: initial })
  return <CloudAgentFields values={values} onChange={(next) => { setValues(next); onValue?.(next.model) }} models={models} modelUi={ui} showInvokePolicy={false} />
}
afterEach(cleanup)

describe("model picker in the cloud agent form", () => {
  it("stays a plain select without the catalog, and shows the helper note", () => {
    render(<Harness ui={{ searchable: false, note: "Only Claude models can be used here: Claude harness." }} />)
    expect(screen.getByLabelText("Model").tagName).toBe("SELECT")
    expect(screen.getByText(/Claude harness/)).toBeInTheDocument()
  })

  it("searches by name, id and provider", () => {
    render(<Harness ui={{ searchable: true }} />)
    const list = screen.getByRole("listbox", { name: "Models" })
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "gpt-5" } })
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("GPT-5"), expect.stringContaining("GPT-5 Mini")]))
    expect(within(list).queryByText("Gemini 3")).toBeNull()
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "google" } })
    expect(within(list).getByText("Gemini 3")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "zzz" } })
    expect(within(list).getByText("No models match.")).toBeInTheDocument()
  })

  it("filters by provider and groups by provider, curated first", () => {
    render(<Harness ui={{ searchable: true }} />)
    const list = screen.getByRole("listbox", { name: "Models" })
    const groups = within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"))
    expect(groups).toEqual(["Recommended", "anthropic", "google", "openai"])
    fireEvent.change(screen.getByLabelText("Filter by provider"), { target: { value: "openai" } })
    expect(within(list).queryByText("Gemini 3")).toBeNull()
    expect(within(list).getByText("GPT-5 Mini")).toBeInTheDocument()
  })

  it("selects a model, and the system default clears it", () => {
    const onValue = vi.fn()
    render(<Harness ui={{ searchable: true }} onValue={onValue} />)
    fireEvent.click(screen.getByRole("option", { name: /Gemini 3/ }))
    expect(onValue).toHaveBeenLastCalledWith("google/gemini-3")
    expect(screen.getByTestId("model-selected")).toHaveTextContent("Gemini 3 (google/gemini-3)")
    fireEvent.click(screen.getByRole("option", { name: "System default" }))
    expect(onValue).toHaveBeenLastCalledWith("")
    expect(screen.getByTestId("model-selected")).toHaveTextContent("System default")
  })

  it("still renders a stored model that is not in the list", () => {
    render(<Harness initial="mistral/old-model" ui={{ searchable: true }} />)
    expect(screen.getByTestId("model-selected")).toHaveTextContent("mistral/old-model (no longer offered)")
  })
})

describe("matchesModelQuery", () => {
  it("matches name, id and provider case-insensitively", () => {
    const option = { value: "openai/gpt-5", label: "GPT-5", provider: "openai" }
    expect(matchesModelQuery(option, "")).toBe(true)
    expect(matchesModelQuery(option, "GPT")).toBe(true)
    expect(matchesModelQuery(option, "OPENAI/")).toBe(true)
    expect(matchesModelQuery(option, "claude")).toBe(false)
  })
})
