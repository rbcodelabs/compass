// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }))

import { EditableText, PanelContainer } from "@/components/panels/panel-parts"
import { resolveSelectionContext } from "@/lib/selection-context"

const TASK = "22222222-2222-4222-8222-222222222222"
const edit = { type: "task" as const, id: TASK, orgSlug: "acme", workspaceSlug: "product", onSaved: () => {} }

afterEach(cleanup)

describe("panel text fields carry selection-context attributes", () => {
  it("EditableText labels its field and entity without adding a box", () => {
    render(<EditableText value="Some notes" field="ownerName" edit={edit} />)
    const wrapper = screen.getByText("Some notes").closest("[data-ctx-field]")!
    expect(wrapper).toHaveAttribute("data-ctx-field", "Owner name")
    expect(wrapper).toHaveAttribute("data-ctx-entity-type", "task")
    expect(wrapper).toHaveAttribute("data-ctx-entity-id", TASK)
    expect(wrapper).toHaveClass("contents")
  })

  it("PanelContainer supplies the entity title that fields do not know", () => {
    render(
      <PanelContainer entity={{ type: "task", id: TASK, title: "Ship it" }}>
        <EditableText value="Body text" field="description" edit={edit} />
      </PanelContainer>,
    )
    const ctx = resolveSelectionContext(screen.getByText("Body text"), { pathname: "/acme/product", search: "" }, { orgSlug: "acme", workspaceSlug: "product" })
    expect(ctx).toMatchObject({ entityType: "task", entityId: TASK, entityTitle: "Ship it", field: "Description" })
  })
})
