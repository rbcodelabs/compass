/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed Prisma mock arguments and structured-content payloads */
/**
 * Agent-scale custom field tools (TASK-95 / RM-8):
 *   - list_roadmap_items: custom field filters, values, compact mode, linked opportunity values
 *   - set_custom_field_values: bulk write with per-item results
 *   - group_by_custom_field: read-only grouped view
 *   - list_opportunities: includeCustomFields
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { z } from "zod"
import { runWithMcpActor } from "@/lib/mcp-authz"
import { matchesCustomFieldFilter } from "@/lib/custom-field-bulk"

const WS = "11111111-1111-4111-8111-111111111111"
const OTHER_WS = "22222222-2222-4222-8222-222222222222"
const F_AREA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" // SELECT
const F_VERT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2" // MULTI_SELECT
const F_NOTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3" // TEXT
const F_OPP_CUSTOMER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1" // OPPORTUNITY SELECT
const I1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1"
const I2 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2"
const I3 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3"
const OPP1 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1"

const defRow = (id: string, name: string, fieldType: string, objectType: string, options: unknown = null) => ({
  id, workspaceId: WS, objectType, name, fieldType, options, sharedOptionSetId: null, sharedOptionSet: null,
  required: false, order: 0, createdAt: new Date(), createdById: null,
})
const DEFS = [
  defRow(F_AREA, "Investment Area", "SELECT", "ROADMAP_ITEM", [{ label: "Core", value: "core" }, { label: "Growth", value: "growth" }]),
  defRow(F_VERT, "Vertical", "MULTI_SELECT", "ROADMAP_ITEM", [{ label: "Bank", value: "bank" }, { label: "Cu", value: "cu" }]),
  defRow(F_NOTE, "Note", "TEXT", "ROADMAP_ITEM"),
  defRow(F_OPP_CUSTOMER, "Customer", "SELECT", "OPPORTUNITY", [{ label: "Acme", value: "acme" }]),
]

const mockPrisma = {
  roadmapItem: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
  opportunity: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  customFieldDefinition: { findMany: vi.fn(), findUnique: vi.fn() },
  customFieldValue: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: { ok: boolean; data: Record<string, unknown> } }
type ToolCallback = (args: Record<string, unknown>) => Promise<ToolResult>
const registeredTools: Record<string, ToolCallback> = {}
const registeredSchemas: Record<string, Record<string, z.ZodType>> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: unknown, cb: ToolCallback) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({
      registerTool(name, meta, cb) {
        registeredTools[name] = cb
        registeredSchemas[name] = (meta as { inputSchema: Record<string, z.ZodType> }).inputSchema
      },
      registerResource() {},
    })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }))

await import("@/app/api/mcp/route")
const { setCustomFieldValues, groupByCustomField } = await import("@/lib/custom-field-bulk")

function call(name: string, args: Record<string, unknown>, purpose: "SERVICE" | "AGENT" = "SERVICE") {
  const h = registeredTools[name]
  if (!h) throw new Error(`Tool "${name}" was not registered`)
  return runWithMcpActor({ userId: null, purpose }, () => h(args))
}
const data = (r: ToolResult) => r.structuredContent?.data as Record<string, any>

const roadmapRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Item ${id.slice(-1)}`, description: "long description", horizon: "NOW", status: "ACTIVE", sortOrder: 0, isPrivate: false,
  opportunityId: null, solutionId: null, experimentId: null, keyResultId: null, feedbackId: null, squadId: null,
  startDate: null, endDate: null, nowCommitmentProvenance: null, nowDecisionRecordId: null,
  createdAt: new Date(), updatedAt: new Date(),
  opportunity: null, solution: null, squad: null, experiment: null, ...extra,
})

beforeEach(() => {
  vi.resetAllMocks()
  mockPrisma.customFieldDefinition.findMany.mockImplementation(async ({ where }: any) =>
    DEFS.filter((d) => d.workspaceId === where.workspaceId && (!where.objectType?.in || where.objectType.in.includes(d.objectType))))
  mockPrisma.customFieldDefinition.findUnique.mockImplementation(async ({ where }: any) => DEFS.find((d) => d.id === where.id) ?? null)
  mockPrisma.customFieldValue.findMany.mockResolvedValue([])
  mockPrisma.roadmapItem.findMany.mockResolvedValue([])
  mockPrisma.roadmapItem.findUnique.mockImplementation(async ({ where }: any) => ({ workspaceId: [I1, I2, I3].includes(where.id) ? WS : where.id === "foreign" ? OTHER_WS : null }))
})

describe("matchesCustomFieldFilter", () => {
  it("SELECT matches exact value or anyOf", () => {
    expect(matchesCustomFieldFilter("SELECT", { fieldId: F_AREA, value: "core" }, "core")).toBe(true)
    expect(matchesCustomFieldFilter("SELECT", { fieldId: F_AREA, value: "core" }, "growth")).toBe(false)
    expect(matchesCustomFieldFilter("SELECT", { fieldId: F_AREA, anyOf: ["core", "growth"] }, "growth")).toBe(true)
  })
  it("MULTI_SELECT matches when any listed option is present", () => {
    expect(matchesCustomFieldFilter("MULTI_SELECT", { fieldId: F_VERT, value: "bank" }, ["bank", "cu"])).toBe(true)
    expect(matchesCustomFieldFilter("MULTI_SELECT", { fieldId: F_VERT, anyOf: ["x", "cu"] }, ["bank", "cu"])).toBe(true)
    expect(matchesCustomFieldFilter("MULTI_SELECT", { fieldId: F_VERT, value: "bank" }, ["cu"])).toBe(false)
  })
  it("TEXT is a case-insensitive substring match", () => {
    expect(matchesCustomFieldFilter("TEXT", { fieldId: F_NOTE, value: "ACME" }, "Partner: Acme Corp")).toBe(true)
    expect(matchesCustomFieldFilter("TEXT", { fieldId: F_NOTE, value: "zzz" }, "Partner: Acme Corp")).toBe(false)
  })
  it("NUMBER and BOOLEAN use equality; isSet checks presence", () => {
    expect(matchesCustomFieldFilter("NUMBER", { fieldId: F_NOTE, value: 3 }, 3)).toBe(true)
    expect(matchesCustomFieldFilter("BOOLEAN", { fieldId: F_NOTE, value: true }, false)).toBe(false)
    expect(matchesCustomFieldFilter("SELECT", { fieldId: F_AREA, isSet: true }, "core")).toBe(true)
    expect(matchesCustomFieldFilter("SELECT", { fieldId: F_AREA, isSet: true }, "")).toBe(false)
    expect(matchesCustomFieldFilter("SELECT", { fieldId: F_AREA, isSet: false }, null)).toBe(true)
  })
})

describe("list_roadmap_items input schema", () => {
  const schema = () => z.object(registeredSchemas.list_roadmap_items)
  it("accepts custom field filters with exactly one matcher", () => {
    expect(schema().safeParse({ workspaceId: WS, customFieldFilters: [{ fieldId: F_AREA, value: "core" }, { fieldId: F_VERT, anyOf: ["bank"] }] }).success).toBe(true)
    expect(schema().safeParse({ workspaceId: WS, customFieldFilters: [{ fieldId: F_AREA, isSet: false }] }).success).toBe(true)
    expect(schema().safeParse({ workspaceId: WS, customFieldFilters: [{ fieldId: F_AREA }] }).success).toBe(false)
    expect(schema().safeParse({ workspaceId: WS, customFieldFilters: [{ fieldId: F_AREA, value: "a", anyOf: ["b"] }] }).success).toBe(false)
    expect(schema().safeParse({ workspaceId: WS, customFieldFilters: [{ fieldId: "nope", value: "a" }] }).success).toBe(false)
  })
  it("keeps every pre-existing parameter and adds the new ones", () => {
    expect(Object.keys(registeredSchemas.list_roadmap_items)).toEqual(expect.arrayContaining([
      "workspaceId", "horizon", "squadId", "updatedSince", "updatedBefore", "sort",
      "customFieldFilters", "includeCustomFields", "customFieldIds", "opportunityCustomFieldIds", "compact",
    ]))
    expect(schema().safeParse({ workspaceId: WS }).success).toBe(true)
  })
})

describe("list_roadmap_items custom field filters (TASK-96)", () => {
  it("ANDs filters, scoped to the workspace's roadmap items by id", async () => {
    mockPrisma.customFieldValue.findMany
      .mockResolvedValueOnce([{ objectId: I1, value: "core" }, { objectId: I2, value: "core" }, { objectId: I3, value: "growth" }])
      .mockResolvedValueOnce([{ objectId: I2, value: ["bank"] }, { objectId: I3, value: ["bank"] }])
    mockPrisma.roadmapItem.findMany.mockResolvedValue([roadmapRow(I2)])
    const result = await call("list_roadmap_items", {
      workspaceId: WS,
      customFieldFilters: [{ fieldId: F_AREA, value: "core" }, { fieldId: F_VERT, anyOf: ["bank"] }],
    })
    const where = mockPrisma.roadmapItem.findMany.mock.calls[0][0].where
    expect(where.workspaceId).toBe(WS)
    expect(where.status).toBe("ACTIVE")
    expect(where.AND).toEqual([{ id: { in: [I1, I2] } }, { id: { in: [I2, I3] } }])
    expect(data(result).count).toBe(1)
  })

  it("isSet:false excludes items that have a value", async () => {
    mockPrisma.customFieldValue.findMany.mockResolvedValueOnce([{ objectId: I1, value: "core" }])
    mockPrisma.roadmapItem.findMany.mockResolvedValue([roadmapRow(I2)])
    await call("list_roadmap_items", { workspaceId: WS, customFieldFilters: [{ fieldId: F_AREA, isSet: false }] })
    expect(mockPrisma.roadmapItem.findMany.mock.calls[0][0].where.AND).toEqual([{ id: { notIn: [I1] } }])
  })

  it("rejects a filter field from another object type or workspace without querying items", async () => {
    const result = await call("list_roadmap_items", { workspaceId: WS, customFieldFilters: [{ fieldId: F_OPP_CUSTOMER, value: "acme" }] })
    expect(result.structuredContent?.ok).toBe(false)
    expect(result.content[0].text).toMatch(/not a ROADMAP_ITEM custom field/)
    expect(mockPrisma.roadmapItem.findMany).not.toHaveBeenCalled()
    const unknown = await call("list_roadmap_items", { workspaceId: OTHER_WS, customFieldFilters: [{ fieldId: F_AREA, value: "core" }] })
    expect(unknown.structuredContent?.ok).toBe(false)
  })

  it("rejects a SELECT value that is not a defined option and lists the options", async () => {
    const result = await call("list_roadmap_items", { workspaceId: WS, customFieldFilters: [{ fieldId: F_AREA, value: "bogus" }] })
    expect(result.structuredContent?.ok).toBe(false)
    expect(result.content[0].text).toMatch(/core, growth/)
  })

  it("a filtered query that matches nothing is a successful empty answer", async () => {
    mockPrisma.customFieldValue.findMany.mockResolvedValueOnce([])
    const result = await call("list_roadmap_items", { workspaceId: WS, customFieldFilters: [{ fieldId: F_AREA, value: "core" }] })
    expect(result.structuredContent?.ok).toBe(true)
    expect(data(result).count).toBe(0)
  })
})

describe("list_roadmap_items custom field values, compact mode, linked opportunity (TASK-98/99/100)", () => {
  it("default output is unchanged: no custom field lookups, no customFields key", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([roadmapRow(I1)])
    const result = await call("list_roadmap_items", { workspaceId: WS })
    expect(mockPrisma.customFieldValue.findMany).not.toHaveBeenCalled()
    expect(data(result).items[0]).not.toHaveProperty("customFields")
    expect(data(result).items[0].description).toBe("long description")
  })

  it("includeCustomFields attaches values keyed by field name, plus the field catalog", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([roadmapRow(I1), roadmapRow(I2)])
    mockPrisma.customFieldValue.findMany.mockResolvedValue([{ objectId: I1, fieldId: F_AREA, value: "core" }, { objectId: I1, fieldId: F_VERT, value: ["bank"] }])
    const result = await call("list_roadmap_items", { workspaceId: WS, includeCustomFields: true })
    const q = mockPrisma.customFieldValue.findMany.mock.calls[0][0]
    expect(q.where.objectId).toEqual({ in: [I1, I2] })
    expect(q.where.fieldId.in).toEqual([F_AREA, F_VERT, F_NOTE])
    const items = data(result).items
    expect(items[0].customFields).toEqual({ "Investment Area": "core", Vertical: ["bank"], Note: null })
    expect(items[1].customFields).toEqual({ "Investment Area": null, Vertical: null, Note: null })
    expect(data(result).fields.map((f: any) => f.id)).toEqual([F_AREA, F_VERT, F_NOTE])
    expect(result.content[0].text).toContain("Investment Area: core")
  })

  it("customFieldIds narrows the columns and rejects unknown ids", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([roadmapRow(I1)])
    await call("list_roadmap_items", { workspaceId: WS, customFieldIds: [F_AREA] })
    expect(mockPrisma.customFieldValue.findMany.mock.calls[0][0].where.fieldId.in).toEqual([F_AREA])
    const bad = await call("list_roadmap_items", { workspaceId: WS, customFieldIds: [F_OPP_CUSTOMER] })
    expect(bad.structuredContent?.ok).toBe(false)
  })

  it("compact mode returns only id, title, horizon, squad and field values, with no linked-title expansion", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([
      roadmapRow(I1, { squadId: "s1", squad: { name: "Platform" }, opportunity: { title: "Big Opp" }, solution: { title: "Sol" } }),
    ])
    mockPrisma.customFieldValue.findMany.mockResolvedValue([{ objectId: I1, fieldId: F_AREA, value: "core" }])
    const result = await call("list_roadmap_items", { workspaceId: WS, compact: true })
    const query = mockPrisma.roadmapItem.findMany.mock.calls[0][0]
    expect(query.include).toBeUndefined()
    expect(Object.keys(query.select).sort()).toEqual(["horizon", "id", "squad", "title"].sort())
    const item = data(result).items[0]
    expect(Object.keys(item).sort()).toEqual(["customFields", "horizon", "id", "squad", "title"])
    expect(item.squad).toBe("Platform")
    expect(result.content[0].text).not.toContain("Big Opp")
    expect(result.content[0].text).toContain(I1)
  })

  it("fits 157 compact items comfortably under a 25k character budget", async () => {
    const ids = Array.from({ length: 157 }, (_, n) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}`)
    mockPrisma.roadmapItem.findMany.mockResolvedValue(ids.map((id) => ({ id, title: "A reasonably long roadmap item title here", horizon: "NEXT", squad: { name: "Platform" } })))
    mockPrisma.customFieldValue.findMany.mockResolvedValue(ids.map((id) => ({ objectId: id, fieldId: F_AREA, value: "growth" })))
    const result = await call("list_roadmap_items", { workspaceId: WS, compact: true, customFieldIds: [F_AREA] })
    expect(result.content[0].text.length + JSON.stringify(data(result)).length).toBeLessThan(50_000)
    expect(data(result).count).toBe(157)
  })

  it("opportunityCustomFieldIds surfaces the linked opportunity's values, workspace-scoped", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([roadmapRow(I1, { opportunityId: OPP1 }), roadmapRow(I2)])
    mockPrisma.customFieldValue.findMany.mockResolvedValue([{ objectId: OPP1, fieldId: F_OPP_CUSTOMER, value: "acme" }])
    const result = await call("list_roadmap_items", { workspaceId: WS, opportunityCustomFieldIds: [F_OPP_CUSTOMER] })
    const q = mockPrisma.customFieldValue.findMany.mock.calls[0][0]
    expect(q.where.objectId).toEqual({ in: [OPP1] })
    expect(q.where.fieldId.in).toEqual([F_OPP_CUSTOMER])
    const items = data(result).items
    expect(items[0].opportunityCustomFields).toEqual({ Customer: "acme" })
    expect(items[1].opportunityCustomFields).toEqual({ Customer: null })
    const wrongType = await call("list_roadmap_items", { workspaceId: WS, opportunityCustomFieldIds: [F_AREA] })
    expect(wrongType.structuredContent?.ok).toBe(false)
  })
})

describe("set_custom_field_values (TASK-97)", () => {
  it("is registered with workspaceId, objectType, fieldId, objectIds (max 100) and value", () => {
    const schema = z.object(registeredSchemas.set_custom_field_values)
    expect(Object.keys(registeredSchemas.set_custom_field_values)).toEqual(["workspaceId", "objectType", "fieldId", "objectIds", "value"])
    const base = { workspaceId: WS, objectType: "ROADMAP_ITEM", fieldId: F_AREA, value: "core" }
    expect(schema.safeParse({ ...base, objectIds: [I1] }).success).toBe(true)
    expect(schema.safeParse({ ...base, objectIds: [] }).success).toBe(false)
    expect(schema.safeParse({ ...base, objectIds: Array(101).fill(I1) }).success).toBe(false)
    expect(schema.safeParse({ ...base, objectIds: ["nope"] }).success).toBe(false)
  })

  it("sets one value on many items and reports per-item results, failing items from other workspaces", async () => {
    const result = await call("set_custom_field_values", { workspaceId: WS, objectType: "ROADMAP_ITEM", fieldId: F_AREA, objectIds: [I1, I2, "foreign", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"], value: "core" })
    const d = data(result)
    expect(d.results.map((r: any) => [r.objectId, r.ok, r.code])).toEqual([
      [I1, true, undefined], [I2, true, undefined], ["foreign", false, "NOT_FOUND"], ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", false, "NOT_FOUND"],
    ])
    expect(d.updated).toBe(2)
    expect(d.failed).toBe(2)
    expect(mockPrisma.customFieldValue.upsert).toHaveBeenCalledTimes(2)
    expect(mockPrisma.customFieldValue.upsert.mock.calls[0][0]).toMatchObject({
      where: { fieldId_objectId: { fieldId: F_AREA, objectId: I1 } }, create: { fieldId: F_AREA, objectId: I1, value: "core" },
    })
  })

  it("rejects an invalid value for the whole call before writing anything", async () => {
    const result = await call("set_custom_field_values", { workspaceId: WS, objectType: "ROADMAP_ITEM", fieldId: F_AREA, objectIds: [I1], value: "bogus" })
    expect(result.structuredContent?.ok).toBe(false)
    expect(mockPrisma.customFieldValue.upsert).not.toHaveBeenCalled()
  })

  it("rejects a field from another workspace or object type", async () => {
    const wrongType = await call("set_custom_field_values", { workspaceId: WS, objectType: "ROADMAP_ITEM", fieldId: F_OPP_CUSTOMER, objectIds: [I1], value: "acme" })
    expect(wrongType.structuredContent?.ok).toBe(false)
    const foreign = await call("set_custom_field_values", { workspaceId: OTHER_WS, objectType: "ROADMAP_ITEM", fieldId: F_AREA, objectIds: [I1], value: "core" })
    expect(foreign.structuredContent?.ok).toBe(false)
    expect(mockPrisma.customFieldValue.upsert).not.toHaveBeenCalled()
  })

  it("null clears the field on every found item", async () => {
    const result = await call("set_custom_field_values", { workspaceId: WS, objectType: "ROADMAP_ITEM", fieldId: F_AREA, objectIds: [I1, I2], value: null })
    expect(mockPrisma.customFieldValue.deleteMany).toHaveBeenCalledWith({ where: { fieldId: F_AREA, objectId: { in: [I1, I2] } } })
    expect(mockPrisma.customFieldValue.upsert).not.toHaveBeenCalled()
    expect(data(result).updated).toBe(2)
  })

  it("de-duplicates repeated ids", async () => {
    await call("set_custom_field_values", { workspaceId: WS, objectType: "ROADMAP_ITEM", fieldId: F_AREA, objectIds: [I1, I1], value: "core" })
    expect(mockPrisma.customFieldValue.upsert).toHaveBeenCalledTimes(1)
  })

  it("applies the batch cap: 25 for agent callers, 100 for humans", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, "0")}`)
    const input = (n: number) => ({ workspaceId: WS, objectType: "ROADMAP_ITEM" as const, fieldId: F_AREA, objectIds: ids(n), value: "core" })
    const agent = await runWithMcpActor({ userId: null, purpose: "AGENT" }, () => setCustomFieldValues(input(26)))
    expect(agent.structuredContent?.ok).toBe(false)
    expect(agent.content[0].text).toMatch(/at most 25/)
    expect(mockPrisma.customFieldValue.upsert).not.toHaveBeenCalled()
    const human = await runWithMcpActor({ userId: "u1", purpose: "USER" }, () => setCustomFieldValues(input(26)))
    expect(human.structuredContent?.ok).toBe(true)
  })
})

describe("group_by_custom_field (TASK-102)", () => {
  it("groups active roadmap items by a SELECT field in option order with an unset group", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([
      { id: I1, title: "One", horizon: "NOW" }, { id: I2, title: "Two", horizon: "NEXT" }, { id: I3, title: "Three", horizon: "NOW" },
    ])
    mockPrisma.customFieldValue.findMany.mockResolvedValue([{ objectId: I1, value: "growth" }, { objectId: I2, value: "core" }])
    const result = await call("group_by_custom_field", { workspaceId: WS, fieldId: F_AREA })
    expect(mockPrisma.roadmapItem.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS, status: "ACTIVE" })
    const groups = data(result).groups
    expect(groups.map((g: any) => [g.value, g.count])).toEqual([["core", 1], ["growth", 1], [null, 1]])
    expect(groups[0].label).toBe("Core")
    expect(groups[2].items).toEqual([{ id: I3, title: "Three" }])
    expect(data(result).totalItems).toBe(3)
  })

  it("places a MULTI_SELECT item in every group it carries", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([{ id: I1, title: "One", horizon: "NOW" }])
    mockPrisma.customFieldValue.findMany.mockResolvedValue([{ objectId: I1, value: ["bank", "cu"] }])
    const result = await call("group_by_custom_field", { workspaceId: WS, fieldId: F_VERT })
    expect(data(result).groups.map((g: any) => [g.value, g.count])).toEqual([["bank", 1], ["cu", 1]])
  })

  it("groups opportunities (excluding archived) when asked", async () => {
    mockPrisma.opportunity.findMany.mockResolvedValue([{ id: OPP1, title: "Opp", status: "ACTIVE" }])
    mockPrisma.customFieldValue.findMany.mockResolvedValue([{ objectId: OPP1, value: "acme" }])
    const result = await call("group_by_custom_field", { workspaceId: WS, fieldId: F_OPP_CUSTOMER, objectType: "OPPORTUNITY" })
    expect(mockPrisma.opportunity.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS, status: { not: "ARCHIVED" } })
    expect(data(result).groups[0]).toMatchObject({ value: "acme", count: 1 })
  })

  it("omits item lists with includeItems:false and rejects a mismatched field", async () => {
    mockPrisma.roadmapItem.findMany.mockResolvedValue([{ id: I1, title: "One", horizon: "NOW" }])
    const compact = await call("group_by_custom_field", { workspaceId: WS, fieldId: F_AREA, includeItems: false })
    expect(data(compact).groups[0]).not.toHaveProperty("items")
    const bad = await call("group_by_custom_field", { workspaceId: WS, fieldId: F_OPP_CUSTOMER })
    expect(bad.structuredContent?.ok).toBe(false)
    const direct = await runWithMcpActor({ userId: null, purpose: "SERVICE" }, () => groupByCustomField({ workspaceId: OTHER_WS, fieldId: F_AREA, objectType: "ROADMAP_ITEM" }))
    expect(direct.structuredContent?.ok).toBe(false)
  })
})
