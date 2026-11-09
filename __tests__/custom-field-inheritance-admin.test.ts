import { beforeEach, describe, expect, it } from "vitest"
import {
  checkRuleCompatibility,
  createInheritanceRule,
  deleteInheritanceRule,
  deleteInheritanceRulesForField,
  InheritanceRuleError,
  listInheritanceRules,
  moveInheritanceRule,
  setInheritanceRuleEnabled,
} from "@/lib/custom-field-inheritance-admin"
import { createInheritanceFakeDb, type InheritanceFakeDb } from "./helpers/inheritance-fake-db"
import { setFeatureTables } from "./helpers/modules"

const WS = "ws-1"
const OTHER = "ws-2"
const opts = (...values: string[]) => values.map((value) => ({ label: value, value }))

let db: InheritanceFakeDb
const create = (input: Partial<Parameters<typeof createInheritanceRule>[1]> = {}) =>
  createInheritanceRule(db.tx as never, { workspaceId: WS, targetFieldId: "dst", sourceFieldId: "src", actorUserId: "user-1", source: "UI", ...input })

beforeEach(() => {
  setFeatureTables({ inheritance: true })
  db = createInheritanceFakeDb({ permissive: true })
  db.addField({ id: "src", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "SELECT", name: "Customer", options: opts("a", "b") })
  db.addField({ id: "dst", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "SELECT", name: "Partner", options: opts("a", "b", "c") })
})

describe("checkRuleCompatibility", () => {
  const def = (fieldType: string, options: { value: string }[] | null = null) => ({ id: "x", name: "x", fieldType, objectType: "OPPORTUNITY", options }) as never

  it("requires identical field types", () => {
    expect(checkRuleCompatibility(def("TEXT"), def("NUMBER"))).toMatch(/same type/i)
    expect(checkRuleCompatibility(def("TEXT"), def("TEXT"))).toBeNull()
  })

  it("requires every source option to exist in the target's options for pick lists", () => {
    expect(checkRuleCompatibility(def("SELECT", opts("a", "z")), def("SELECT", opts("a", "b")))).toMatch(/z/)
    expect(checkRuleCompatibility(def("MULTI_SELECT", opts("a")), def("MULTI_SELECT", opts("a", "b")))).toBeNull()
  })
})

describe("createInheritanceRule", () => {
  it("creates a rule with the next priority, enabled, stamped with the actor and source", async () => {
    const first = await create()
    expect(first).toMatchObject({ workspaceId: WS, targetObjectType: "ROADMAP_ITEM", sourceObjectType: "OPPORTUNITY", priority: 0, enabled: true, createdById: "user-1", source: "UI" })

    db.addField({ id: "src2", workspaceId: WS, objectType: "SOLUTION", fieldType: "SELECT", name: "Area", options: opts("a") })
    const second = await create({ sourceFieldId: "src2" })
    expect(second).toMatchObject({ sourceObjectType: "SOLUTION", priority: 1 })
  })

  it("rejects a field that belongs to another workspace, indistinguishably from a missing one", async () => {
    db.addField({ id: "foreign", workspaceId: OTHER, objectType: "OPPORTUNITY", fieldType: "SELECT", name: "Customer", options: opts("a") })
    await expect(create({ sourceFieldId: "foreign" })).rejects.toThrow(/field not found/i)
    await expect(create({ targetFieldId: "foreign" })).rejects.toThrow(/field not found/i)
    await expect(create({ sourceFieldId: "nope" })).rejects.toThrow(/field not found/i)
    expect(db.tables.customFieldInheritanceRule).toHaveLength(0)
  })

  it("scopes every definition lookup to the caller's workspace", async () => {
    await create()
    const lookups = db.queries.filter((query) => query.model === "customFieldDefinition")
    expect(lookups.length).toBeGreaterThan(0)
    for (const lookup of lookups) expect(lookup.where.workspaceId).toBe(WS)
  })

  it("only allows ROADMAP_ITEM targets and OPPORTUNITY or SOLUTION sources", async () => {
    db.addField({ id: "task-field", workspaceId: WS, objectType: "TASK", fieldType: "SELECT", name: "T", options: opts("a") })
    await expect(create({ targetFieldId: "task-field" })).rejects.toThrow(/roadmap item/i)
    await expect(create({ sourceFieldId: "dst" })).rejects.toThrow(/opportunity or solution/i)
  })

  it("rejects different field types and option mismatches at creation", async () => {
    db.addField({ id: "txt", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "TEXT", name: "Txt" })
    await expect(create({ targetFieldId: "txt" })).rejects.toThrow(/same type/i)
    db.addField({ id: "narrow", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "SELECT", name: "Narrow", options: opts("a") })
    await expect(create({ targetFieldId: "narrow" })).rejects.toThrow(/b/)
  })

  it.each([[-1], [1.5], [1001], [Number.NaN]])("rejects priority %s (must be a whole number from 0 to 1000)", async (priority) => {
    await expect(create({ priority })).rejects.toThrow(/whole number from 0 to 1000/)
    expect(db.tables.customFieldInheritanceRule).toHaveLength(0)
  })

  it.each([[0], [1000]])("accepts the boundary priority %s", async (priority) => {
    await expect(create({ priority })).resolves.toMatchObject({ priority })
  })

  it("rejects a duplicate source/target pair with a friendly error", async () => {
    await create()
    await expect(create()).rejects.toBeInstanceOf(InheritanceRuleError)
  })
})

describe("managing rules", () => {
  it("lists rules in priority order with an active / disabled / inactive status", async () => {
    const a = await create()
    db.addField({ id: "src2", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "SELECT", name: "Area", options: opts("a") })
    const b = await create({ sourceFieldId: "src2" })
    await setInheritanceRuleEnabled(db.tx as never, WS, b.id, false)
    // Option drift after creation: the target loses an option the source still has.
    db.tables.customFieldDefinition.find((row) => row.id === "dst")!.options = opts("a")

    const rules = await listInheritanceRules(db.tx as never, WS)

    expect(rules.map((rule) => [rule.id, rule.status])).toEqual([[a.id, "inactive"], [b.id, "disabled"]])
    expect(rules[0]).toMatchObject({ inactiveReason: expect.stringMatching(/options mismatch/i), sourceFieldName: "Customer", targetFieldName: "Partner" })
  })

  it("toggles and deletes only rules in the caller's workspace", async () => {
    const rule = await create()
    await expect(setInheritanceRuleEnabled(db.tx as never, OTHER, rule.id, false)).rejects.toThrow(/not found/i)
    await expect(deleteInheritanceRule(db.tx as never, OTHER, rule.id)).rejects.toThrow(/not found/i)
    expect(db.tables.customFieldInheritanceRule[0].enabled).toBe(true)

    await setInheritanceRuleEnabled(db.tx as never, WS, rule.id, false)
    expect(db.tables.customFieldInheritanceRule[0].enabled).toBe(false)
    await deleteInheritanceRule(db.tx as never, WS, rule.id)
    expect(db.tables.customFieldInheritanceRule).toHaveLength(0)
  })

  it("reorders priority by swapping with the neighbour of the same target field", async () => {
    const a = await create()
    db.addField({ id: "src2", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "SELECT", name: "Area", options: opts("a") })
    const b = await create({ sourceFieldId: "src2" })

    await moveInheritanceRule(db.tx as never, WS, b.id, "up")

    const byId = Object.fromEntries(db.tables.customFieldInheritanceRule.map((row) => [row.id, row.priority]))
    expect(byId[b.id]).toBe(0)
    expect(byId[a.id]).toBe(1)
    // Moving the top rule up again is a no-op, not an error.
    await expect(moveInheritanceRule(db.tx as never, WS, b.id, "up")).resolves.toBeUndefined()
  })

  it("removes every rule that names a field as target or source, in that workspace only", async () => {
    await create()
    db.addRule({ id: "foreign-rule", workspaceId: OTHER, targetFieldId: "dst", sourceFieldId: "src", sourceObjectType: "OPPORTUNITY" })

    await deleteInheritanceRulesForField(db.tx as never, WS, "src")

    expect(db.tables.customFieldInheritanceRule.map((row) => row.id)).toEqual(["foreign-rule"])
    const deletes = db.queries.filter((query) => query.op === "deleteMany")
    for (const query of deletes) expect(query.where.workspaceId).toBe(WS)
  })
})
