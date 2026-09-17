// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FieldValuePicker } from "@/components/custom-fields/field-value-picker"
import type { SelectOption } from "@/lib/types"

/**
 * The picker exists because the editor it replaces was a free-text box that
 * comma-split whatever was typed. A user shown "ZZ Alpha" naturally typed
 * "ZZ Alpha", which stored a value no option had, so every filter over that
 * field came back empty with nothing explaining why.
 *
 * These tests pin the property that fixes it — labels are the only thing shown,
 * values are the only thing emitted — plus the removal paths, because clearing
 * a custom field has never had a test that actually exercised the UI.
 */

const options: SelectOption[] = [
  { label: "ZZ Alpha", value: "zz_alpha" },
  { label: "ZZ Beta", value: "zz_beta", color: "#ff0000" },
  { label: "ZZ Gamma", value: "zz_gamma" },
]

afterEach(cleanup)

function openPicker(fieldName: string) {
  fireEvent.click(screen.getByLabelText(fieldName))
}

describe("FieldValuePicker — MULTI_SELECT", () => {
  it("shows stored values by label and never leaks the stored slug", () => {
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={["zz_alpha", "zz_beta"]}
        onChange={vi.fn()}
      />
    )

    const trigger = screen.getByLabelText("Product Area")
    expect(trigger).toHaveTextContent("ZZ Alpha")
    expect(trigger).toHaveTextContent("ZZ Beta")
    expect(trigger.textContent).not.toContain("zz_alpha")
    expect(trigger.textContent).not.toContain("zz_beta")
  })

  it("offers every option by label, with the stored ones marked selected", async () => {
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={["zz_alpha"]}
        onChange={vi.fn()}
      />
    )
    openPicker("Product Area")

    expect(
      (await screen.findByRole("option", { name: "ZZ Alpha" })).getAttribute("aria-selected")
    ).toBe("true")
    expect(screen.getByRole("option", { name: "ZZ Beta" }).getAttribute("aria-selected")).toBe(
      "false"
    )
    expect(screen.getByRole("option", { name: "ZZ Gamma" })).toBeInTheDocument()
  })

  it("emits the option's value — not its label — when one is picked", async () => {
    const onChange = vi.fn()
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={[]}
        onChange={onChange}
      />
    )
    openPicker("Product Area")
    fireEvent.click(await screen.findByRole("option", { name: "ZZ Alpha" }))

    expect(onChange).toHaveBeenCalledWith(["zz_alpha"])
  })

  it("adds to the existing selection rather than replacing it", async () => {
    const onChange = vi.fn()
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={["zz_alpha"]}
        onChange={onChange}
      />
    )
    openPicker("Product Area")
    fireEvent.click(await screen.findByRole("option", { name: "ZZ Beta" }))

    expect(onChange).toHaveBeenCalledWith(["zz_alpha", "zz_beta"])
  })

  it("removes a single value by unpicking it, leaving the rest", async () => {
    const onChange = vi.fn()
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={["zz_alpha", "zz_beta"]}
        onChange={onChange}
      />
    )
    openPicker("Product Area")
    fireEvent.click(await screen.findByRole("option", { name: "ZZ Alpha" }))

    expect(onChange).toHaveBeenCalledWith(["zz_beta"])
  })

  it("clears the whole field in one action", () => {
    const onChange = vi.fn()
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={["zz_alpha", "zz_beta"]}
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Clear Product Area" }))

    expect(onChange).toHaveBeenCalledWith([])
  })

  it("offers no clear action when the field is already empty", () => {
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={null}
        onChange={vi.fn()}
      />
    )

    expect(screen.queryByRole("button", { name: "Clear Product Area" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("Product Area")).toHaveTextContent("Empty")
  })

  it("filters the list by typed text so a long picklist stays usable", async () => {
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={[]}
        onChange={vi.fn()}
      />
    )
    openPicker("Product Area")
    await screen.findByRole("option", { name: "ZZ Alpha" })

    fireEvent.change(screen.getByPlaceholderText("Search Product Area…"), {
      target: { value: "Gamma" },
    })

    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["ZZ Gamma"])
  })

  it("carries each option's colour through to its badge", () => {
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={["zz_beta"]}
        onChange={vi.fn()}
      />
    )

    expect(screen.getByText("ZZ Beta")).toHaveStyle({ backgroundColor: "#ff0000" })
  })
})

describe("FieldValuePicker — SELECT", () => {
  it("shows the stored value's label, not its slug", () => {
    render(
      <FieldValuePicker
        fieldName="Release Stage"
        fieldType="SELECT"
        options={options}
        value="zz_beta"
        onChange={vi.fn()}
      />
    )

    const trigger = screen.getByLabelText("Release Stage")
    expect(trigger).toHaveTextContent("ZZ Beta")
    expect(trigger.textContent).not.toContain("zz_beta")
  })

  it("emits a bare value string, replacing any previous choice", async () => {
    const onChange = vi.fn()
    render(
      <FieldValuePicker
        fieldName="Release Stage"
        fieldType="SELECT"
        options={options}
        value="zz_alpha"
        onChange={onChange}
      />
    )
    openPicker("Release Stage")
    fireEvent.click(await screen.findByRole("option", { name: "ZZ Beta" }))

    expect(onChange).toHaveBeenCalledWith("zz_beta")
  })

  it("clears back to null", () => {
    const onChange = vi.fn()
    render(
      <FieldValuePicker
        fieldName="Release Stage"
        fieldType="SELECT"
        options={options}
        value="zz_alpha"
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Clear Release Stage" }))

    expect(onChange).toHaveBeenCalledWith(null)
  })
})

describe("FieldValuePicker — values the option list no longer offers", () => {
  const stored = ["zz_alpha", "ZZ Gamma"] // second is a label typed into the old free-text editor

  it("still displays the unmatched value instead of dropping it", () => {
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={stored}
        onChange={vi.fn()}
      />
    )

    expect(screen.getByLabelText("Product Area")).toHaveTextContent("ZZ Gamma")
  })

  it("lists it as selected and flags that it is not one of the field's options", async () => {
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={stored}
        onChange={vi.fn()}
      />
    )
    openPicker("Product Area")

    const stale = await screen.findByRole("option", { name: /ZZ Gamma.*not in this list/i })
    expect(stale.getAttribute("aria-selected")).toBe("true")
  })

  it("lets the unmatched value be removed", async () => {
    const onChange = vi.fn()
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={stored}
        onChange={onChange}
      />
    )
    openPicker("Product Area")
    fireEvent.click(await screen.findByRole("option", { name: /ZZ Gamma.*not in this list/i }))

    expect(onChange).toHaveBeenCalledWith(["zz_alpha"])
  })

  it("preserves it when an unrelated option is toggled", async () => {
    // Regression guard: a selection reported as "only the options I recognise"
    // would quietly delete legacy data the moment any other option was touched.
    const onChange = vi.fn()
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={options}
        value={stored}
        onChange={onChange}
      />
    )
    openPicker("Product Area")
    fireEvent.click(await screen.findByRole("option", { name: "ZZ Beta" }))

    expect(onChange).toHaveBeenCalledWith(["zz_alpha", "ZZ Gamma", "zz_beta"])
  })

  it("handles a SELECT whose stored value is no longer offered", async () => {
    const onChange = vi.fn()
    render(
      <FieldValuePicker
        fieldName="Release Stage"
        fieldType="SELECT"
        options={options}
        value="ZZ Delta"
        onChange={onChange}
      />
    )

    expect(screen.getByLabelText("Release Stage")).toHaveTextContent("ZZ Delta")
    openPicker("Release Stage")
    expect(
      await screen.findByRole("option", { name: /ZZ Delta.*not in this list/i })
    ).toBeInTheDocument()
  })

  it("survives a field that has no option list at all", () => {
    render(
      <FieldValuePicker
        fieldName="Product Area"
        fieldType="MULTI_SELECT"
        options={null}
        value={["orphan"]}
        onChange={vi.fn()}
      />
    )

    expect(screen.getByLabelText("Product Area")).toHaveTextContent("orphan")
  })
})
