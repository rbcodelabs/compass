import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Prisma mock ──────────────────────────────────────────────────────────────
const mockPrisma = {
  customFieldDefinition: { findMany: vi.fn(), findUnique: vi.fn() },
  customFieldValue: { findMany: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() },
  task: { findUnique: vi.fn() },
  roadmapItem: { findUnique: vi.fn() },
  opportunity: { findUnique: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import {
  listCustomFieldDefinitions,
  getCustomFieldValues,
  setCustomFieldValue,
  validateValueForFieldType,
  CUSTOM_FIELD_ENTITY,
} from "@/lib/custom-field-tool-handlers"

beforeEach(() => vi.clearAllMocks())

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ResultShape = { content: { text: string }[]; structuredContent: { ok: boolean; message: string; data: any } }

function buildFieldRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "field-1",
    workspaceId: "ws-1",
    objectType: "TASK",
    name: "Priority Tier",
    fieldType: "TEXT",
    options: null,
    sharedOptionSetId: null,
    required: false,
    order: 0,
    sharedOptionSet: null,
    ...overrides,
  }
}

describe("CUSTOM_FIELD_ENTITY", () => {
  it("maps all 7 CustomFieldObjectTypes to a WorkspaceEntityType", () => {
    expect(CUSTOM_FIELD_ENTITY).toEqual({
      OPPORTUNITY: "opportunity",
      SOLUTION: "solution",
      EXPERIMENT: "experiment",
      OBJECTIVE: "objective",
      KEY_RESULT: "keyResult",
      ROADMAP_ITEM: "roadmapItem",
      TASK: "task",
    })
  })
})

describe("validateValueForFieldType", () => {
  it("accepts null for every field type", () => {
    for (const fieldType of ["TEXT", "NUMBER", "DATE", "SELECT", "MULTI_SELECT", "URL", "BOOLEAN"] as const) {
      expect(validateValueForFieldType(fieldType, null, null)).toBeNull()
    }
  })

  it("TEXT/URL require a string", () => {
    expect(validateValueForFieldType("TEXT", null, "hello")).toBeNull()
    expect(validateValueForFieldType("URL", null, "https://example.com")).toBeNull()
    expect(validateValueForFieldType("TEXT", null, 42)).toMatch(/Expected a string/)
  })

  it("NUMBER requires a finite number", () => {
    expect(validateValueForFieldType("NUMBER", null, 42)).toBeNull()
    expect(validateValueForFieldType("NUMBER", null, "42")).toMatch(/Expected a finite number/)
    expect(validateValueForFieldType("NUMBER", null, Infinity)).toMatch(/Expected a finite number/)
    expect(validateValueForFieldType("NUMBER", null, NaN)).toMatch(/Expected a finite number/)
  })

  it("BOOLEAN requires a boolean", () => {
    expect(validateValueForFieldType("BOOLEAN", null, true)).toBeNull()
    expect(validateValueForFieldType("BOOLEAN", null, "true")).toMatch(/Expected a boolean/)
  })

  it("DATE requires a Date.parse-able string", () => {
    expect(validateValueForFieldType("DATE", null, "2026-09-17")).toBeNull()
    expect(validateValueForFieldType("DATE", null, "not-a-date")).toMatch(/Expected a date string/)
    expect(validateValueForFieldType("DATE", null, 123)).toMatch(/Expected a date string/)
  })

  it("SELECT requires one of the field's options", () => {
    const options = [{ label: "High", value: "high" }, { label: "Low", value: "low" }]
    expect(validateValueForFieldType("SELECT", options, "high")).toBeNull()
    const error = validateValueForFieldType("SELECT", options, "medium")
    expect(error).toMatch(/not one of this field's defined options/)
    expect(error).toMatch(/high, low/)
    expect(validateValueForFieldType("SELECT", options, 42)).toMatch(/Expected a string option value/)
  })

  it("MULTI_SELECT requires every entry to be one of the field's options", () => {
    const options = [{ label: "Web", value: "web" }, { label: "Mobile", value: "mobile" }]
    expect(validateValueForFieldType("MULTI_SELECT", options, ["web", "mobile"])).toBeNull()
    const error = validateValueForFieldType("MULTI_SELECT", options, ["web", "desktop"])
    expect(error).toMatch(/not among this field's defined options/)
    expect(validateValueForFieldType("MULTI_SELECT", options, "web")).toMatch(/Expected an array/)
  })
})

describe("listCustomFieldDefinitions", () => {
  it("delegates to loadCustomFieldDefinitions with the given workspace and objectType filter", async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([])
    await listCustomFieldDefinitions({ workspaceId: "ws-1", objectType: "TASK" })
    expect(mockPrisma.customFieldDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1", objectType: { in: ["TASK"] } } })
    )
  })

  it("omits the objectType filter when none is given", async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([])
    await listCustomFieldDefinitions({ workspaceId: "ws-1" })
    expect(mockPrisma.customFieldDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1" } })
    )
  })

  it("reports an empty-message fallback when there are no definitions", async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([])
    const result = (await listCustomFieldDefinitions({ workspaceId: "ws-1" })) as ResultShape
    expect(result.content[0].text).toBe("No custom field definitions found.")
    expect(result.structuredContent.data).toEqual({ items: [], count: 0 })
  })

  it("lists definitions including SELECT option values in the text", async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      buildFieldRow({ id: "f1", fieldType: "SELECT", options: [{ label: "High", value: "high" }], required: true }),
    ])
    const result = (await listCustomFieldDefinitions({ workspaceId: "ws-1" })) as ResultShape
    expect(result.content[0].text).toContain("Priority Tier")
    expect(result.content[0].text).toContain("required")
    expect(result.content[0].text).toContain("high")
    expect(result.structuredContent.data.count).toBe(1)
  })
})

describe("getCustomFieldValues", () => {
  it("fails when the object does not resolve", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(null)
    const result = (await getCustomFieldValues({ objectType: "TASK", objectId: "task-1" })) as ResultShape
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toBe('TASK "task-1" not found.')
  })

  it("reports an empty-message fallback when the object type defines no fields", async () => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([])
    const result = (await getCustomFieldValues({ objectType: "TASK", objectId: "task-1" })) as ResultShape
    expect(result.content[0].text).toBe("No custom fields are defined for this object type.")
    expect(result.structuredContent.data).toEqual({ items: [], count: 0 })
  })

  it("pairs each definition with the object's current value", async () => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([buildFieldRow({ id: "f1" })])
    mockPrisma.customFieldValue.findMany.mockResolvedValue([{ fieldId: "f1", value: "Tier 1" }])
    const result = (await getCustomFieldValues({ objectType: "TASK", objectId: "task-1" })) as ResultShape
    expect(result.structuredContent.data.count).toBe(1)
    expect(result.structuredContent.data.items[0].currentValue).toBe("Tier 1")
    expect(result.content[0].text).toContain("Tier 1")
  })
})

describe("setCustomFieldValue", () => {
  it("fails when the object does not resolve", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(null)
    const result = (await setCustomFieldValue({ objectType: "TASK", objectId: "task-1", fieldId: "f1", value: "x" })) as ResultShape
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toBe('TASK "task-1" not found.')
    expect(mockPrisma.customFieldDefinition.findUnique).not.toHaveBeenCalled()
  })

  it("fails when the field does not exist", async () => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue(null)
    const result = (await setCustomFieldValue({ objectType: "TASK", objectId: "task-1", fieldId: "missing", value: "x" })) as ResultShape
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toBe('Custom field "missing" not found.')
  })

  it("rejects a field belonging to a different workspace", async () => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue(buildFieldRow({ workspaceId: "ws-2" }))
    const result = (await setCustomFieldValue({ objectType: "TASK", objectId: "task-1", fieldId: "f1", value: "x" })) as ResultShape
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/does not belong to the same workspace/)
    expect(mockPrisma.customFieldValue.upsert).not.toHaveBeenCalled()
  })

  it("rejects a field defined for a different objectType", async () => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue(buildFieldRow({ objectType: "OPPORTUNITY" }))
    const result = (await setCustomFieldValue({ objectType: "TASK", objectId: "task-1", fieldId: "f1", value: "x" })) as ResultShape
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/is defined for OPPORTUNITY, not TASK/)
    expect(mockPrisma.customFieldValue.upsert).not.toHaveBeenCalled()
  })

  it("rejects a value that fails type validation and does not write", async () => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue(buildFieldRow({ fieldType: "NUMBER" }))
    const result = (await setCustomFieldValue({ objectType: "TASK", objectId: "task-1", fieldId: "f1", value: "not-a-number" })) as ResultShape
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/Expected a finite number/)
    expect(mockPrisma.customFieldValue.upsert).not.toHaveBeenCalled()
    expect(mockPrisma.customFieldValue.deleteMany).not.toHaveBeenCalled()
  })

  it("rejects a SELECT value outside the field's options and names the allowed values", async () => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue(
      buildFieldRow({ fieldType: "SELECT", options: [{ label: "High", value: "high" }, { label: "Low", value: "low" }] })
    )
    const result = (await setCustomFieldValue({ objectType: "TASK", objectId: "task-1", fieldId: "f1", value: "medium" })) as ResultShape
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/high, low/)
  })

  it.each([
    ["NUMBER", 42],
    ["BOOLEAN", true],
    ["DATE", "2026-09-17"],
  ])("sets a valid %s value", async (fieldType, value) => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue(buildFieldRow({ fieldType }))
    const result = (await setCustomFieldValue({ objectType: "TASK", objectId: "task-1", fieldId: "f1", value })) as ResultShape
    expect(result.structuredContent.ok).toBe(true)
    expect(mockPrisma.customFieldValue.upsert).toHaveBeenCalledWith({
      where: { fieldId_objectId: { fieldId: "f1", objectId: "task-1" } },
      create: { fieldId: "f1", objectId: "task-1", value },
      update: { value, updatedAt: expect.any(Date) },
    })
    expect(result.structuredContent.data).toEqual({
      fieldId: "f1",
      objectId: "task-1",
      objectType: "TASK",
      fieldType,
      value,
    })
  })

  it("sets a valid SELECT value", async () => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue(
      buildFieldRow({ fieldType: "SELECT", options: [{ label: "High", value: "high" }] })
    )
    const result = (await setCustomFieldValue({ objectType: "TASK", objectId: "task-1", fieldId: "f1", value: "high" })) as ResultShape
    expect(result.structuredContent.ok).toBe(true)
    expect(mockPrisma.customFieldValue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { fieldId: "f1", objectId: "task-1", value: "high" } })
    )
  })

  it("sets a valid MULTI_SELECT value, resolving effective options from a shared option set", async () => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue(
      buildFieldRow({
        fieldType: "MULTI_SELECT",
        options: null,
        sharedOptionSetId: "set-1",
        sharedOptionSet: { id: "set-1", name: "Product Area", options: [{ label: "Web", value: "web" }, { label: "Mobile", value: "mobile" }] },
      })
    )
    const result = (await setCustomFieldValue({ objectType: "TASK", objectId: "task-1", fieldId: "f1", value: ["web", "mobile"] })) as ResultShape
    expect(result.structuredContent.ok).toBe(true)
    expect(mockPrisma.customFieldValue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { fieldId: "f1", objectId: "task-1", value: ["web", "mobile"] } })
    )
  })

  // Clearing must take priority over type validation for EVERY field type —
  // null/""/[] means "unset this field" regardless of what type it is,
  // exactly matching upsertFieldValue's own clearing check. Before the fix
  // for this, clearing ran AFTER validateValueForFieldType, so e.g. value: ""
  // against a NUMBER field failed with "Expected a finite number... got """
  // instead of clearing — these cases pin down that every field type accepts
  // every clearing form without ever reaching validation.
  it.each([
    [null, "TEXT"],
    [null, "NUMBER"],
    [null, "BOOLEAN"],
    [null, "DATE"],
    [null, "SELECT"],
    [null, "MULTI_SELECT"],
    ["", "TEXT"],
    ["", "URL"],
    ["", "NUMBER"],
    ["", "BOOLEAN"],
    ["", "DATE"],
    ["", "SELECT"],
    [[], "TEXT"],
    [[], "URL"],
    [[], "MULTI_SELECT"],
  ])("clears the value via %j on a %s field, deleting rather than upserting", async (clearingValue, fieldType) => {
    mockPrisma.task.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue(buildFieldRow({ fieldType }))
    const result = (await setCustomFieldValue({ objectType: "TASK", objectId: "task-1", fieldId: "f1", value: clearingValue })) as ResultShape
    expect(result.structuredContent.ok).toBe(true)
    expect(mockPrisma.customFieldValue.deleteMany).toHaveBeenCalledWith({ where: { fieldId: "f1", objectId: "task-1" } })
    expect(mockPrisma.customFieldValue.upsert).not.toHaveBeenCalled()
    expect(result.structuredContent.data.value).toBeNull()
  })

  it("resolves the object through a different entity type (ROADMAP_ITEM)", async () => {
    mockPrisma.roadmapItem.findUnique.mockResolvedValue({ workspaceId: "ws-1" })
    mockPrisma.customFieldDefinition.findUnique.mockResolvedValue(buildFieldRow({ objectType: "ROADMAP_ITEM" }))
    const result = (await setCustomFieldValue({ objectType: "ROADMAP_ITEM", objectId: "ri-1", fieldId: "f1", value: "hello" })) as ResultShape
    expect(result.structuredContent.ok).toBe(true)
    expect(mockPrisma.task.findUnique).not.toHaveBeenCalled()
  })
})
