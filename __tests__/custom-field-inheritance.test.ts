import { beforeEach, describe, expect, it, vi } from "vitest"
import { applyInheritanceForSourceValue, applyInheritanceRules } from "@/lib/custom-field-inheritance"
import { createInheritanceFakeDb, type InheritanceFakeDb } from "./helpers/inheritance-fake-db"
import { setFeatureTables } from "./helpers/modules"

const WS = "ws-1"
const OTHER_WS = "ws-2"
const ITEM = "item-1"
const OPP = "opp-1"
const SOL = "sol-1"

const customerOptions = [{ label: "Acme", value: "acme" }, { label: "Globex", value: "globex" }]
const partnerOptions = [{ label: "Acme", value: "acme" }, { label: "Globex", value: "globex" }, { label: "Initech", value: "initech" }]

let db: InheritanceFakeDb

/** Customer (opportunity, SELECT) -> Partner (roadmap item, SELECT), priority 0. */
function seedCustomerToPartner() {
  db.addField({ id: "f-customer", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "SELECT", name: "Customer", options: customerOptions })
  db.addField({ id: "f-partner", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "SELECT", name: "Partner", options: partnerOptions })
  db.addRule({ id: "r-1", workspaceId: WS, targetFieldId: "f-partner", sourceFieldId: "f-customer", sourceObjectType: "OPPORTUNITY", priority: 0 })
  db.addEntity("opportunity", OPP, WS)
}

const apply = (links: { opportunityId?: string | null; solutionId?: string | null } = { opportunityId: OPP }, workspaceId = WS) =>
  applyInheritanceRules(db.tx, { workspaceId, targetObjectType: "ROADMAP_ITEM", targetId: ITEM, links })

beforeEach(() => {
  db = createInheritanceFakeDb()
  setFeatureTables({ inheritance: true })
})

describe("applyInheritanceRules", () => {
  it("fills an empty target from the linked source and reports what was inherited", async () => {
    seedCustomerToPartner()
    db.addValue("f-customer", OPP, "acme")

    const result = await apply()

    expect(db.valueOf("f-partner", ITEM)).toBe("acme")
    expect(result.applied).toEqual([
      expect.objectContaining({ fieldId: "f-partner", fieldName: "Partner", from: expect.objectContaining({ objectType: "OPPORTUNITY", objectId: OPP, fieldId: "f-customer", fieldName: "Customer" }) }),
    ])
  })

  it("never overwrites an explicit target value", async () => {
    seedCustomerToPartner()
    db.addValue("f-customer", OPP, "acme")
    db.addValue("f-partner", ITEM, "globex")

    const result = await apply()

    expect(db.valueOf("f-partner", ITEM)).toBe("globex")
    expect(result.applied).toEqual([])
  })

  it.each([
    ["BOOLEAN false", "BOOLEAN", false, true],
    ["NUMBER 0", "NUMBER", 0, 42],
  ])("treats an explicit falsy value (%s) as set and never overwrites it", async (_label, fieldType, explicit, sourceValue) => {
    db.addField({ id: "src", workspaceId: WS, objectType: "OPPORTUNITY", fieldType, name: "Src" })
    db.addField({ id: "dst", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType, name: "Dst" })
    db.addRule({ id: "r-f", workspaceId: WS, targetFieldId: "dst", sourceFieldId: "src", sourceObjectType: "OPPORTUNITY" })
    db.addEntity("opportunity", OPP, WS)
    db.addValue("src", OPP, sourceValue)
    db.addValue("dst", ITEM, explicit)

    await apply()

    expect(db.valueOf("dst", ITEM)).toBe(explicit)
  })

  it("inherits an explicit falsy SOURCE value (false / 0 are values, not empty)", async () => {
    db.addField({ id: "src", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "BOOLEAN", name: "Src" })
    db.addField({ id: "dst", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "BOOLEAN", name: "Dst" })
    db.addRule({ id: "r-f", workspaceId: WS, targetFieldId: "dst", sourceFieldId: "src", sourceObjectType: "OPPORTUNITY" })
    db.addEntity("opportunity", OPP, WS)
    db.addValue("src", OPP, false)

    await apply()

    expect(db.valueOf("dst", ITEM)).toBe(false)
  })

  it("falls back by priority: the first rule yielding a value wins and later rules see the field as filled", async () => {
    seedCustomerToPartner()
    db.addField({ id: "f-area", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "SELECT", name: "Investment Area", options: customerOptions })
    db.addRule({ id: "r-2", workspaceId: WS, targetFieldId: "f-partner", sourceFieldId: "f-area", sourceObjectType: "OPPORTUNITY", priority: 1 })

    // Customer empty -> falls through to Investment Area.
    db.addValue("f-area", OPP, "globex")
    await apply()
    expect(db.valueOf("f-partner", ITEM)).toBe("globex")
  })

  it("lets the lower priority win when both sources have a value, and writes once", async () => {
    seedCustomerToPartner()
    db.addField({ id: "f-area", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "SELECT", name: "Investment Area", options: customerOptions })
    db.addRule({ id: "r-2", workspaceId: WS, targetFieldId: "f-partner", sourceFieldId: "f-area", sourceObjectType: "OPPORTUNITY", priority: 1 })
    db.addValue("f-customer", OPP, "acme")
    db.addValue("f-area", OPP, "globex")

    const result = await apply()

    expect(db.valueOf("f-partner", ITEM)).toBe("acme")
    expect(result.applied).toHaveLength(1)
    expect(db.values().filter((row) => row.fieldId === "f-partner")).toHaveLength(1)
  })

  it.each([[""], [[]], [undefined]])("skips an empty source value (%j)", async (empty) => {
    seedCustomerToPartner()
    if (empty !== undefined) db.addValue("f-customer", OPP, empty)

    const result = await apply()

    expect(db.valueOf("f-partner", ITEM)).toBeUndefined()
    expect(result.applied).toEqual([])
  })

  it("skips a source entity that no longer exists in the workspace", async () => {
    seedCustomerToPartner()
    db.tables.opportunity.length = 0 // deleted; its value rows linger because nothing cascades
    db.addValue("f-customer", OPP, "acme")

    await apply()

    expect(db.valueOf("f-partner", ITEM)).toBeUndefined()
  })

  it("skips silently, without throwing, when the field types have drifted apart", async () => {
    seedCustomerToPartner()
    db.tables.customFieldDefinition.find((row) => row.id === "f-partner")!.fieldType = "TEXT"
    db.addValue("f-customer", OPP, "acme")

    const result = await apply()

    expect(db.valueOf("f-partner", ITEM)).toBeUndefined()
    expect(result.skipped).toEqual([expect.objectContaining({ ruleId: "r-1", reason: "type_mismatch" })])
  })

  it("skips when the source value is no longer an option of the target (option drift)", async () => {
    seedCustomerToPartner()
    db.tables.customFieldDefinition.find((row) => row.id === "f-partner")!.options = [{ label: "Acme", value: "acme" }]
    db.addValue("f-customer", OPP, "globex")

    const result = await apply()

    expect(db.valueOf("f-partner", ITEM)).toBeUndefined()
    expect(result.skipped).toEqual([expect.objectContaining({ ruleId: "r-1", reason: "options_mismatch" })])
  })

  it("resolves shared option sets as the effective options", async () => {
    db.addField({ id: "src", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "SELECT", name: "Src", sharedOptionSetId: "set-1", sharedOptionSet: { id: "set-1", name: "Set", options: customerOptions } })
    db.addField({ id: "dst", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "SELECT", name: "Dst", options: partnerOptions })
    db.addRule({ id: "r-s", workspaceId: WS, targetFieldId: "dst", sourceFieldId: "src", sourceObjectType: "OPPORTUNITY" })
    db.addEntity("opportunity", OPP, WS)
    db.addValue("src", OPP, "acme")

    await apply()

    expect(db.valueOf("dst", ITEM)).toBe("acme")
  })

  it("copies a MULTI_SELECT array", async () => {
    db.addField({ id: "src", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "MULTI_SELECT", name: "Src", options: customerOptions })
    db.addField({ id: "dst", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "MULTI_SELECT", name: "Dst", options: partnerOptions })
    db.addRule({ id: "r-m", workspaceId: WS, targetFieldId: "dst", sourceFieldId: "src", sourceObjectType: "OPPORTUNITY" })
    db.addEntity("opportunity", OPP, WS)
    db.addValue("src", OPP, ["acme", "globex"])

    await apply()

    expect(db.valueOf("dst", ITEM)).toEqual(["acme", "globex"])
  })

  it("is idempotent", async () => {
    seedCustomerToPartner()
    db.addValue("f-customer", OPP, "acme")

    await apply()
    const second = await apply()

    expect(second.applied).toEqual([])
    expect(db.values().filter((row) => row.fieldId === "f-partner")).toHaveLength(1)
  })

  it("ignores disabled rules", async () => {
    seedCustomerToPartner()
    db.tables.customFieldInheritanceRule[0].enabled = false
    db.addValue("f-customer", OPP, "acme")

    await apply()

    expect(db.valueOf("f-partner", ITEM)).toBeUndefined()
  })

  it("reads a SOLUTION source through solutionId and ignores rules for a source type that is not linked", async () => {
    db.addField({ id: "s-field", workspaceId: WS, objectType: "SOLUTION", fieldType: "TEXT", name: "Track" })
    db.addField({ id: "dst", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "TEXT", name: "Track" })
    db.addRule({ id: "r-sol", workspaceId: WS, targetFieldId: "dst", sourceFieldId: "s-field", sourceObjectType: "SOLUTION" })
    db.addEntity("solution", SOL, WS)
    db.addValue("s-field", SOL, "platform")

    await apply({ opportunityId: OPP })
    expect(db.valueOf("dst", ITEM)).toBeUndefined()

    await apply({ solutionId: SOL })
    expect(db.valueOf("dst", ITEM)).toBe("platform")
  })

  it("does nothing, and issues no queries, when the item has no links", async () => {
    seedCustomerToPartner()
    db.addValue("f-customer", OPP, "acme")

    const result = await apply({})

    expect(result.applied).toEqual([])
    expect(db.queries).toEqual([])
  })

  it("treats a missing rules table as no rules and issues no queries", async () => {
    seedCustomerToPartner()
    db.addValue("f-customer", OPP, "acme")
    setFeatureTables({ inheritance: false })

    const result = await apply()

    expect(result.applied).toEqual([])
    expect(db.queries).toEqual([])
  })

  it("never reads another workspace: foreign rules, definitions and sources are invisible, and every scoped query carries the workspace", async () => {
    seedCustomerToPartner()
    db.addValue("f-customer", OPP, "acme")
    // A foreign workspace's rule on the same target field, and the same opportunity id living in the other workspace.
    db.addRule({ id: "r-x", workspaceId: OTHER_WS, targetFieldId: "f-partner", sourceFieldId: "f-customer", sourceObjectType: "OPPORTUNITY", priority: 5 })

    await apply({ opportunityId: OPP }, OTHER_WS)
    expect(db.valueOf("f-partner", ITEM)).toBeUndefined()

    db.queries.length = 0
    await apply()
    const scoped = db.queries.filter((query) => ["customFieldInheritanceRule", "customFieldDefinition", "opportunity", "solution", "roadmapItem"].includes(query.model))
    expect(scoped.length).toBeGreaterThan(0)
    for (const query of scoped) expect(query.where.workspaceId, `${query.model}.${query.op}`).toBe(WS)
  })

  it("only ever inserts: it never updates, upserts or deletes", async () => {
    seedCustomerToPartner()
    db.addValue("f-customer", OPP, "acme")
    await expect(apply()).resolves.toBeDefined()
  })
})

describe("applyInheritanceForSourceValue (late source values)", () => {
  const late = (fieldId = "f-customer", sourceObjectType: "OPPORTUNITY" | "SOLUTION" = "OPPORTUNITY", sourceId = OPP, workspaceId = WS) =>
    applyInheritanceForSourceValue(db.tx, { workspaceId, sourceObjectType, sourceId, fieldId })

  beforeEach(() => {
    seedCustomerToPartner()
  })

  it("fills the empty target on a linked roadmap item once the source value arrives", async () => {
    db.addRoadmapItem(ITEM, WS, { opportunityId: OPP })
    db.addValue("f-customer", OPP, "acme")

    const result = await late()

    expect(db.valueOf("f-partner", ITEM)).toBe("acme")
    expect(result.applied).toEqual([expect.objectContaining({ itemId: ITEM, fieldId: "f-partner" })])
  })

  it("does not overwrite a target that was set by hand in between", async () => {
    db.addRoadmapItem(ITEM, WS, { opportunityId: OPP })
    db.addValue("f-partner", ITEM, "initech")
    db.addValue("f-customer", OPP, "acme")

    await late()

    expect(db.valueOf("f-partner", ITEM)).toBe("initech")
  })

  it("never rewrites a target when the source later changes from X to Y", async () => {
    db.addRoadmapItem(ITEM, WS, { opportunityId: OPP })
    db.addValue("f-customer", OPP, "acme")
    await late()
    db.tables.customFieldValue.find((row) => row.fieldId === "f-customer")!.value = "globex"

    await late()

    expect(db.valueOf("f-partner", ITEM)).toBe("acme")
  })

  it("never clears a target when the source is cleared", async () => {
    db.addRoadmapItem(ITEM, WS, { opportunityId: OPP })
    db.addValue("f-customer", OPP, "acme")
    await late()
    db.tables.customFieldValue.splice(db.tables.customFieldValue.findIndex((row) => row.fieldId === "f-customer"), 1)

    await late()

    expect(db.valueOf("f-partner", ITEM)).toBe("acme")
  })

  it("leaves items linked to a different source, or to none, untouched", async () => {
    db.addRoadmapItem(ITEM, WS, { opportunityId: "opp-other" })
    db.addRoadmapItem("item-2", WS)
    db.addValue("f-customer", OPP, "acme")

    await late()

    expect(db.values().filter((row) => row.fieldId === "f-partner")).toHaveLength(0)
  })

  it("does nothing for a field that is not the source of any enabled rule", async () => {
    db.addRoadmapItem(ITEM, WS, { opportunityId: OPP })
    db.addField({ id: "f-other", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "TEXT", name: "Other" })
    db.addValue("f-other", OPP, "x")

    const result = await late("f-other")

    expect(result.applied).toEqual([])
    expect(db.queries.some((query) => query.model === "roadmapItem")).toBe(false)
  })

  it("does nothing when the rules table is missing", async () => {
    db.addRoadmapItem(ITEM, WS, { opportunityId: OPP })
    db.addValue("f-customer", OPP, "acme")
    setFeatureTables({ inheritance: false })

    expect((await late()).applied).toEqual([])
    expect(db.queries).toEqual([])
  })

  it("is scoped to the workspace of the write", async () => {
    db.addRoadmapItem(ITEM, WS, { opportunityId: OPP })
    db.addValue("f-customer", OPP, "acme")

    await late("f-customer", "OPPORTUNITY", OPP, OTHER_WS)

    expect(db.valueOf("f-partner", ITEM)).toBeUndefined()
  })

  it("caps one write at 500 linked items and logs a counted skip for the rest", async () => {
    for (let index = 0; index < 503; index++) db.addRoadmapItem(`bulk-${index}`, WS, { opportunityId: OPP })
    db.addValue("f-customer", OPP, "acme")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const result = await late()

    expect(db.values().filter((row) => row.fieldId === "f-partner")).toHaveLength(500)
    expect(result.skippedByCap).toBe(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("custom-field-inheritance"), expect.objectContaining({ skippedByCap: 3 }))
    warn.mockRestore()
  })
})

describe("review fixes", () => {
  const WS2 = "ws-1"
  beforeEach(() => {
    db = createInheritanceFakeDb()
    setFeatureTables({ inheritance: true })
    seedCustomerToPartner()
  })
  const late = () => applyInheritanceForSourceValue(db.tx, { workspaceId: WS2, sourceObjectType: "OPPORTUNITY", sourceId: OPP, fieldId: "f-customer" })

  it("never fills an archived roadmap item, and archived items take no slot in the cap window", async () => {
    db.addRoadmapItem("archived-1", WS, { opportunityId: OPP, status: "ARCHIVED" })
    db.addRoadmapItem("active-1", WS, { opportunityId: OPP })
    db.addValue("f-customer", OPP, "acme")

    await late()

    expect(db.valueOf("f-partner", "archived-1")).toBeUndefined()
    expect(db.valueOf("f-partner", "active-1")).toBe("acme")
  })

  it("a later write progresses past the cap: items already filled take no slot, so the next 3 get filled", async () => {
    for (let index = 0; index < 503; index++) db.addRoadmapItem(`bulk-${String(index).padStart(4, "0")}`, WS, { opportunityId: OPP })
    db.addValue("f-customer", OPP, "acme")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const first = await late()
    expect(first.skippedByCap).toBe(3)
    expect(db.values().filter((row) => row.fieldId === "f-partner")).toHaveLength(500)

    const second = await late()
    expect(second.skippedByCap).toBe(0)
    expect(db.values().filter((row) => row.fieldId === "f-partner")).toHaveLength(503)
    warn.mockRestore()
  })

  it("reports only the values actually written: a concurrent explicit write that wins the race is not reported as inherited", async () => {
    db.addRoadmapItem(ITEM, WS, { opportunityId: OPP })
    db.addValue("f-customer", OPP, "acme")
    const original = db.tx.customFieldValue.createManyAndReturn.bind(db.tx.customFieldValue)
    // The user sets Partner by hand between the empty-check and the insert.
    ;(db.tx.customFieldValue as unknown as { createManyAndReturn: unknown }).createManyAndReturn = async (args: unknown) => {
      db.addValue("f-partner", ITEM, "initech")
      return original(args as never)
    }

    const result = await applyInheritanceRules(db.tx, { workspaceId: WS, targetObjectType: "ROADMAP_ITEM", targetId: ITEM, links: { opportunityId: OPP } })

    expect(result.applied).toEqual([])
    expect(db.valueOf("f-partner", ITEM)).toBe("initech")
  })
})
