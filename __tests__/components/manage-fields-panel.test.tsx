// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/actions", () => ({
  createFieldDefinition: vi.fn(),
  deleteFieldDefinition: vi.fn(),
  updateFieldDefinition: vi.fn(),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import { ManageFieldsPanel } from "@/components/custom-fields/manage-fields-panel"
import type { CustomFieldDefinitionData } from "@/lib/types"

afterEach(cleanup)

const field = (id: string, name: string): CustomFieldDefinitionData =>
  ({
    id,
    workspaceId: "ws-1",
    objectType: "TASK",
    name,
    fieldType: "SELECT",
    options: [{ label: "Low", value: "low" }],
    required: false,
    order: 0,
    sharedOptionSetId: null,
    sharedOptionSetName: null,
  }) as unknown as CustomFieldDefinitionData

describe("ManageFieldsPanel", () => {
  it("shows a field added elsewhere once the server re-renders with it", () => {
    // Adding a field calls router.refresh(); the panel must render the refreshed
    // list rather than the one it happened to mount with.
    const props = { orgSlug: "org", workspaceSlug: "ws", sharedOptionSets: [] }
    const { rerender } = render(<ManageFieldsPanel {...props} initialFields={[field("f1", "Priority")]} />)
    expect(screen.getByText("Priority")).toBeInTheDocument()

    rerender(
      <ManageFieldsPanel
        {...props}
        initialFields={[field("f1", "Priority"), field("f2", "Severity")]}
      />
    )
    expect(screen.getByText("Severity")).toBeInTheDocument()
  })
})
