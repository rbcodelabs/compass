import { beforeEach, describe, expect, it, vi } from "vitest"
import { setFeatureTables } from "./helpers/modules"

const mockPrisma = {
  customFieldInheritanceRule: { findMany: vi.fn() },
  customFieldDefinition: { findMany: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { listCustomFieldInheritanceRules } from "@/lib/custom-field-tool-handlers"

const opts = (...values: string[]) => values.map((value) => ({ label: value, value }))
const field = (id: string, objectType: string, name: string, options: { value: string }[] = opts("a", "b")) => ({
  id, workspaceId: "ws-1", objectType, name, fieldType: "SELECT", options, sharedOptionSetId: null, required: false, order: 0, sharedOptionSet: null,
})
const rule = (overrides: Record<string, unknown> = {}) => ({
  id: "rule-1", workspaceId: "ws-1", targetObjectType: "ROADMAP_ITEM", targetFieldId: "dst", sourceObjectType: "OPPORTUNITY", sourceFieldId: "src",
  priority: 0, enabled: true, source: "UI", createdAt: new Date("2026-11-08T00:00:00Z"), ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  setFeatureTables({ inheritance: true })
  mockPrisma.customFieldInheritanceRule.findMany.mockResolvedValue([rule()])
  mockPrisma.customFieldDefinition.findMany.mockResolvedValue([field("src", "OPPORTUNITY", "Customer"), field("dst", "ROADMAP_ITEM", "Partner", opts("a", "b", "c"))])
})

describe("list_custom_field_inheritance_rules", () => {
  it("lists the workspace's rules with field names and an active status", async () => {
    const result = await listCustomFieldInheritanceRules({ workspaceId: "ws-1" })

    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { count: 1, items: [{ id: "rule-1", priority: 0, enabled: true, status: "active", sourceObjectType: "OPPORTUNITY", sourceField: { id: "src", name: "Customer" }, targetObjectType: "ROADMAP_ITEM", targetField: { id: "dst", name: "Partner" } }] },
    })
    expect(result.content[0].text).toContain("Customer")
    expect(result.content[0].text).toContain("Partner")
  })

  it("scopes both reads to the workspace", async () => {
    await listCustomFieldInheritanceRules({ workspaceId: "ws-1" })
    expect(mockPrisma.customFieldInheritanceRule.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws-1" }) }))
    expect(mockPrisma.customFieldDefinition.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws-1" }) }))
  })

  it("flags a rule whose options have drifted as inactive with the reason", async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([field("src", "OPPORTUNITY", "Customer", opts("a", "z")), field("dst", "ROADMAP_ITEM", "Partner")])
    const result = await listCustomFieldInheritanceRules({ workspaceId: "ws-1" })
    expect(result.structuredContent.data.items[0]).toMatchObject({ status: "inactive", inactiveReason: expect.stringMatching(/options mismatch/i) })
  })

  it("returns an empty list, not an error, while the table does not exist", async () => {
    setFeatureTables({ inheritance: false })
    const result = await listCustomFieldInheritanceRules({ workspaceId: "ws-1" })
    expect(result.structuredContent).toMatchObject({ ok: true, data: { items: [], count: 0 } })
    expect(mockPrisma.customFieldInheritanceRule.findMany).not.toHaveBeenCalled()
  })
})
