/**
 * Independent QA edge cases for custom field inheritance (TASK-101). Complements custom-field-inheritance*.test.ts.
 * Tests whose name starts with "KNOWN LIMITATION" pin CURRENT behaviour that QA flagged as a risk; if one of them
 * starts failing, behaviour changed on purpose and the QA note should be revisited.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { applyInheritanceForSourceValue, applyInheritanceRules } from "@/lib/custom-field-inheritance"
import {
  createInheritanceRule,
  deleteInheritanceRule,
  deleteInheritanceRulesForField,
  listInheritanceRules,
  moveInheritanceRule,
  setInheritanceRuleEnabled,
} from "@/lib/custom-field-inheritance-admin"
import { writeCustomFieldValue } from "@/lib/custom-field-value-write"
import { createInheritanceFakeDb, type InheritanceFakeDb } from "./helpers/inheritance-fake-db"
import { setFeatureTables } from "./helpers/modules"

const WS = "ws-1"
const OTHER_WS = "ws-2"
const ITEM = "item-1"
const OPP = "opp-1"
const SOL = "sol-1"
const opts = (...values: string[]) => values.map((value) => ({ label: value.toUpperCase(), value }))

let db: InheritanceFakeDb

beforeEach(() => {
  db = createInheritanceFakeDb()
  setFeatureTables({ inheritance: true })
})

const apply = (links: { opportunityId?: string | null; solutionId?: string | null }, itemId = ITEM, workspaceId = WS) =>
  applyInheritanceRules(db.tx, { workspaceId, targetObjectType: "ROADMAP_ITEM", targetId: itemId, links })

const late = (fieldId: string, sourceObjectType: "OPPORTUNITY" | "SOLUTION" = "OPPORTUNITY", sourceId = OPP, workspaceId = WS) =>
  applyInheritanceForSourceValue(db.tx, { workspaceId, sourceObjectType, sourceId, fieldId })

/** One source -> one target rule of the given type, with a live opportunity. */
function pair(fieldType: string, sourceOptions: unknown = null, targetOptions: unknown = null, sourceType: "OPPORTUNITY" | "SOLUTION" = "OPPORTUNITY") {
  db.addField({ id: "src", workspaceId: WS, objectType: sourceType, fieldType, name: "Src", options: sourceOptions })
  db.addField({ id: "dst", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType, name: "Dst", options: targetOptions })
  db.addRule({ id: "r-1", workspaceId: WS, targetFieldId: "dst", sourceFieldId: "src", sourceObjectType: sourceType })
  db.addEntity(sourceType === "OPPORTUNITY" ? "opportunity" : "solution", sourceType === "OPPORTUNITY" ? OPP : SOL, WS)
}

describe("value types", () => {
  it.each([
    ["TEXT", "hello world"],
    ["URL", "https://example.com/a?b=1"],
    ["DATE", "2026-11-09"],
    ["NUMBER", 12.5],
    ["NUMBER", -3],
    ["NUMBER", 0],
    ["BOOLEAN", true],
  ])("copies a %s value verbatim (%j)", async (fieldType, value) => {
    pair(fieldType)
    db.addValue("src", OPP, value)
    await apply({ opportunityId: OPP })
    expect(db.valueOf("dst", ITEM)).toStrictEqual(value)
  })

  it.each([
    ["NUMBER", "not-a-number"],
    ["NUMBER", Number.NaN],
    ["DATE", "garbage"],
    ["TEXT", 42],
    ["BOOLEAN", "true"],
  ])("never writes a corrupt %s source value (%j); it is a counted invalid_value skip", async (fieldType, value) => {
    pair(fieldType)
    db.addValue("src", OPP, value)
    const result = await apply({ opportunityId: OPP })
    expect(db.valueOf("dst", ITEM)).toBeUndefined()
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "invalid_value" })])
  })

  it("treats whitespace-only TEXT as a value (it is not a clearing value)", async () => {
    pair("TEXT")
    db.addValue("src", OPP, "   ")
    await apply({ opportunityId: OPP })
    expect(db.valueOf("dst", ITEM)).toBe("   ")
  })
})

describe("MULTI_SELECT and option drift", () => {
  it("copies a subset selection when the target offers a superset of options", async () => {
    pair("MULTI_SELECT", opts("a", "b"), opts("a", "b", "c"))
    db.addValue("src", OPP, ["b"])
    await apply({ opportunityId: OPP })
    expect(db.valueOf("dst", ITEM)).toEqual(["b"])
  })

  it("skips the whole value when the target dropped ONE of the options (no partial copy)", async () => {
    pair("MULTI_SELECT", opts("a", "b"), opts("a", "b"))
    db.addValue("src", OPP, ["a", "b"])
    db.tables.customFieldDefinition.find((row) => row.id === "dst")!.options = opts("a")
    const result = await apply({ opportunityId: OPP })
    expect(db.valueOf("dst", ITEM)).toBeUndefined()
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "options_mismatch" })])
  })

  it("skips when the source ALLOWS an option the target lacks, even if the stored value does not use it (rule-level mismatch)", async () => {
    pair("SELECT", opts("a", "z"), opts("a", "b"))
    db.addValue("src", OPP, "a")
    const result = await apply({ opportunityId: OPP })
    expect(db.valueOf("dst", ITEM)).toBeUndefined()
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "options_mismatch" })])
  })

  it("shared option set on the TARGET drifts: an option removed from the set stops the fill", async () => {
    db.addField({ id: "src", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "SELECT", name: "Src", options: opts("a", "b") })
    db.addField({ id: "dst", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "SELECT", name: "Dst", sharedOptionSetId: "set", sharedOptionSet: { id: "set", name: "Set", options: opts("a", "b") } })
    db.addRule({ id: "r-1", workspaceId: WS, targetFieldId: "dst", sourceFieldId: "src", sourceObjectType: "OPPORTUNITY" })
    db.addEntity("opportunity", OPP, WS)
    db.addValue("src", OPP, "b")

    db.tables.customFieldDefinition.find((row) => row.id === "dst")!.sharedOptionSet = { id: "set", name: "Set", options: opts("a") }
    const drifted = await apply({ opportunityId: OPP })
    expect(drifted.applied).toEqual([])
    expect(db.valueOf("dst", ITEM)).toBeUndefined()
    expect((await listInheritanceRules(db.tx as never, WS))[0]).toMatchObject({ status: "inactive" })

    db.tables.customFieldDefinition.find((row) => row.id === "dst")!.sharedOptionSet = { id: "set", name: "Set", options: opts("a", "b") }
    await apply({ opportunityId: OPP })
    expect(db.valueOf("dst", ITEM)).toBe("b")
  })

  it("a SELECT with null options on the target accepts nothing (no crash on null options)", async () => {
    pair("SELECT", opts("a"), null)
    db.addValue("src", OPP, "a")
    const result = await apply({ opportunityId: OPP })
    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "options_mismatch" })])
  })

  it("a deleted TARGET definition is a counted field_missing skip, not an error", async () => {
    pair("TEXT")
    db.addValue("src", OPP, "x")
    db.tables.customFieldDefinition = db.tables.customFieldDefinition.filter((row) => row.id !== "dst")
    const result = await apply({ opportunityId: OPP })
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "field_missing" })])
  })

  it("a definition whose objectType changed underneath the rule is field_missing, never written", async () => {
    pair("TEXT")
    db.addValue("src", OPP, "x")
    db.tables.customFieldDefinition.find((row) => row.id === "dst")!.objectType = "OPPORTUNITY"
    const result = await apply({ opportunityId: OPP })
    expect(db.valueOf("dst", ITEM)).toBeUndefined()
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "field_missing" })])
  })
})

describe("two rules, one target, OPPORTUNITY and SOLUTION sources", () => {
  function seed(priorities: { opp: number; sol: number }) {
    db.addField({ id: "f-opp", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "TEXT", name: "Opp text" })
    db.addField({ id: "f-sol", workspaceId: WS, objectType: "SOLUTION", fieldType: "TEXT", name: "Sol text" })
    db.addField({ id: "dst", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "TEXT", name: "Dst" })
    db.addRule({ id: "r-opp", workspaceId: WS, targetFieldId: "dst", sourceFieldId: "f-opp", sourceObjectType: "OPPORTUNITY", priority: priorities.opp })
    db.addRule({ id: "r-sol", workspaceId: WS, targetFieldId: "dst", sourceFieldId: "f-sol", sourceObjectType: "SOLUTION", priority: priorities.sol })
    db.addEntity("opportunity", OPP, WS)
    db.addEntity("solution", SOL, WS)
  }

  it("an item linked to both takes the LOWER priority number, whichever entity type it is", async () => {
    seed({ opp: 1, sol: 0 })
    db.addValue("f-opp", OPP, "from-opp")
    db.addValue("f-sol", SOL, "from-sol")
    const result = await apply({ opportunityId: OPP, solutionId: SOL })
    expect(db.valueOf("dst", ITEM)).toBe("from-sol")
    expect(result.applied).toHaveLength(1)
  })

  it("falls through to the second rule when the higher-priority source is empty", async () => {
    seed({ opp: 1, sol: 0 })
    db.addValue("f-opp", OPP, "from-opp")
    await apply({ opportunityId: OPP, solutionId: SOL })
    expect(db.valueOf("dst", ITEM)).toBe("from-opp")
  })

  it("an item linked only to the opportunity ignores the solution rule even if it has the lower priority", async () => {
    seed({ opp: 1, sol: 0 })
    db.addValue("f-opp", OPP, "from-opp")
    db.addValue("f-sol", SOL, "from-sol")
    await apply({ opportunityId: OPP })
    expect(db.valueOf("dst", ITEM)).toBe("from-opp")
  })

  it("rules with equal priority (impossible in the DB, but defensively) resolve deterministically by id, not by insertion order", async () => {
    seed({ opp: 0, sol: 0 })
    db.addValue("f-opp", OPP, "from-opp")
    db.addValue("f-sol", SOL, "from-sol")
    // The fake ignores orderBy, so only assert the contract: exactly one write, never two.
    await apply({ opportunityId: OPP, solutionId: SOL })
    expect(db.values().filter((row) => row.fieldId === "dst")).toHaveLength(1)
  })

  it("a late OPPORTUNITY value fills a target that a lower-priority SOLUTION rule could also fill, but only from the rule that has a value", async () => {
    seed({ opp: 0, sol: 1 })
    db.addRoadmapItem(ITEM, WS, { opportunityId: OPP, solutionId: SOL })
    db.addValue("f-sol", SOL, "from-sol") // solution already had a value when the item was linked elsewhere
    db.addValue("f-opp", OPP, "from-opp")
    await late("f-opp")
    expect(db.valueOf("dst", ITEM)).toBe("from-opp")
  })

  it("KNOWN LIMITATION: a late write fills from ANY enabled rule for the target, not only the rule fed by the written field", async () => {
    seed({ opp: 0, sol: 1 })
    db.addRoadmapItem(ITEM, WS, { opportunityId: OPP, solutionId: SOL })
    db.addValue("f-sol", SOL, "from-sol") // existing value on the solution; target was empty (rule added after linking)
    db.addField({ id: "f-unrelated", workspaceId: WS, objectType: "OPPORTUNITY", fieldType: "TEXT", name: "Unrelated" })
    db.addRule({ id: "r-unrelated", workspaceId: WS, targetFieldId: "dst", sourceFieldId: "f-unrelated", sourceObjectType: "OPPORTUNITY", priority: 2 })
    db.addValue("f-unrelated", OPP, "x")

    await late("f-unrelated")

    // The write was to f-unrelated (priority 2) but the target was filled by the solution rule (priority 1).
    expect(db.valueOf("dst", ITEM)).toBe("from-sol")
  })

  it("a rule disabled between two applications stops contributing; the earlier fill stays", async () => {
    seed({ opp: 0, sol: 1 })
    db.addValue("f-opp", OPP, "from-opp")
    db.addValue("f-sol", SOL, "from-sol")
    await apply({ opportunityId: OPP, solutionId: SOL }, "item-a")
    db.tables.customFieldInheritanceRule.find((row) => row.id === "r-opp")!.enabled = false
    await apply({ opportunityId: OPP, solutionId: SOL }, "item-b")
    expect(db.valueOf("dst", "item-a")).toBe("from-opp")
    expect(db.valueOf("dst", "item-b")).toBe("from-sol")
  })
})

describe("cross-workspace and identity edge cases", () => {
  it("a source id that exists ONLY in another workspace is invisible, even with the same id and a value", async () => {
    pair("TEXT")
    db.tables.opportunity.length = 0
    db.addEntity("opportunity", OPP, OTHER_WS)
    db.addValue("src", OPP, "leak?")
    await apply({ opportunityId: OPP })
    expect(db.valueOf("dst", ITEM)).toBeUndefined()
  })

  it("a late write only touches items of the writing workspace even when ids collide across workspaces", async () => {
    pair("TEXT")
    db.addRoadmapItem("mine", WS, { opportunityId: OPP })
    db.addRoadmapItem("theirs", OTHER_WS, { opportunityId: OPP })
    db.addValue("src", OPP, "v")
    await late("src")
    expect(db.valueOf("dst", "mine")).toBe("v")
    expect(db.valueOf("dst", "theirs")).toBeUndefined()
  })

  it("rejects an unsupported target type and an unsupported source type without a single query", async () => {
    pair("TEXT")
    db.queries.length = 0
    await expect(applyInheritanceRules(db.tx, { workspaceId: WS, targetObjectType: "TASK" as never, targetId: ITEM, links: { opportunityId: OPP } })).resolves.toEqual({ applied: [], skipped: [] })
    await expect(applyInheritanceForSourceValue(db.tx, { workspaceId: WS, sourceObjectType: "TASK" as never, sourceId: "t", fieldId: "src" })).resolves.toMatchObject({ applied: [], itemsScanned: 0 })
    expect(db.queries).toEqual([])
  })
})

describe("concurrency: createMany skipDuplicates", () => {
  it("a racing explicit write that lands between read and insert is never overwritten", async () => {
    pair("TEXT")
    db.addValue("src", OPP, "inherited")
    const original = db.tx.customFieldValue.createManyAndReturn.bind(db.tx.customFieldValue)
    db.tx.customFieldValue.createManyAndReturn = (async (args: never) => {
      db.addValue("dst", ITEM, "typed-by-human") // the human wins the race
      return original(args)
    }) as never

    await apply({ opportunityId: OPP })

    expect(db.valueOf("dst", ITEM)).toBe("typed-by-human")
    expect(db.values().filter((row) => row.fieldId === "dst")).toHaveLength(1)
  })

  it("when the race is lost, the result does NOT report the value as inherited (only rows actually written are reported)", async () => {
    pair("TEXT")
    db.addValue("src", OPP, "inherited")
    const original = db.tx.customFieldValue.createManyAndReturn.bind(db.tx.customFieldValue)
    db.tx.customFieldValue.createManyAndReturn = (async (args: never) => {
      db.addValue("dst", ITEM, "typed-by-human")
      return original(args)
    }) as never

    const result = await apply({ opportunityId: OPP })

    expect(db.valueOf("dst", ITEM)).toBe("typed-by-human")
    expect(result.applied).toEqual([])
  })
})

describe("missing rules table", () => {
  beforeEach(() => setFeatureTables({ inheritance: false }))

  it("both hooks are silent no-ops", async () => {
    pair("TEXT")
    db.addRoadmapItem(ITEM, WS, { opportunityId: OPP })
    db.addValue("src", OPP, "x")
    db.queries.length = 0
    expect((await apply({ opportunityId: OPP })).applied).toEqual([])
    expect(await late("src")).toMatchObject({ applied: [], itemsScanned: 0, skippedByCap: 0 })
    expect(db.queries).toEqual([])
  })

  it("the value funnel degrades to a plain upsert outside any transaction", async () => {
    const prisma = { customFieldValue: { upsert: vi.fn(), deleteMany: vi.fn() }, $transaction: vi.fn() }
    const result = await writeCustomFieldValue(prisma as never, { workspaceId: WS, objectType: "OPPORTUNITY", objectId: OPP, fieldId: "src", value: "x" })
    expect(prisma.customFieldValue.upsert).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(result).toEqual({ cleared: false, inheritedItems: 0 })
  })
})

describe("archived items and the 500 cap", () => {
  const addItem = (id: string, status: "ACTIVE" | "ARCHIVED" = "ACTIVE") => {
    db.addRoadmapItem(id, WS, { opportunityId: OPP })
    db.tables.roadmapItem.find((row) => row.id === id)!.status = status
  }
  const targetCount = () => db.values().filter((row) => row.fieldId === "dst").length

  it.each([
    [499, 499, 0],
    [500, 500, 0],
    [501, 500, 1],
    [1000, 500, 500],
  ])("%i linked items: fills %i, counts %i skipped by the cap", async (total, filled, skippedByCap) => {
    pair("TEXT")
    for (let i = 0; i < total; i++) addItem(`item-${String(i).padStart(5, "0")}`)
    db.addValue("src", OPP, "v")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const result = await late("src")

    expect(targetCount()).toBe(filled)
    expect(result.skippedByCap).toBe(skippedByCap)
    expect(result.itemsScanned).toBe(Math.min(total, 500))
    expect(warn).toHaveBeenCalledTimes(skippedByCap > 0 ? 1 : 0)
    warn.mockRestore()
  })

  it("items past the cap are reached by the next write for the source (filled items take no slot)", async () => {
    pair("TEXT")
    for (let i = 0; i < 700; i++) addItem(`item-${String(i).padStart(5, "0")}`)
    db.addValue("src", OPP, "v1")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const first = await late("src")
    expect(first.skippedByCap).toBe(200)
    expect(targetCount()).toBe(500)
    db.tables.customFieldValue.find((row) => row.fieldId === "src")!.value = "v2"
    const second = await late("src")

    expect(targetCount()).toBe(700)
    expect(second.applied).toHaveLength(200)
    expect(second.skippedByCap).toBe(0)
    // The first 500 kept their original value: a changed source never rewrites a filled target.
    expect(db.valueOf("dst", "item-00000")).toBe("v1")
    expect(db.valueOf("dst", "item-00600")).toBe("v2")
    warn.mockRestore()
  })

  it("archived items are never filled and take no cap slots", async () => {
    pair("TEXT")
    for (let i = 0; i < 500; i++) addItem(`a-${String(i).padStart(5, "0")}`, "ARCHIVED")
    addItem("z-active", "ACTIVE")
    db.addValue("src", OPP, "v")

    await late("src")

    expect(db.valueOf("dst", "a-00000")).toBeUndefined()
    expect(db.valueOf("dst", "z-active")).toBe("v")
  })

  it("KNOWN LIMITATION: a target the user deliberately emptied is refilled by the next source write", async () => {
    pair("TEXT")
    addItem(ITEM)
    db.addValue("src", OPP, "v1")
    await late("src")
    expect(db.valueOf("dst", ITEM)).toBe("v1")
    db.tables.customFieldValue = db.tables.customFieldValue.filter((row) => !(row.fieldId === "dst" && row.objectId === ITEM)) // user clears it
    db.tables.customFieldValue.find((row) => row.fieldId === "src")!.value = "v2"
    await late("src")
    expect(db.valueOf("dst", ITEM)).toBe("v2")
  })
})

/** Rule store with the real unique indexes (workspace,target,priority) and (workspace,target,source). */
function uniqueRuleDb() {
  const fake = createInheritanceFakeDb({ permissive: true })
  const original = fake.tx.customFieldInheritanceRule.updateMany.bind(fake.tx.customFieldInheritanceRule)
  fake.tx.customFieldInheritanceRule.updateMany = (async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if (typeof args.data.priority === "number") {
      const target = fake.tables.customFieldInheritanceRule.find((row) => row.id === args.where.id)
      const clash = fake.tables.customFieldInheritanceRule.some((row) => row.id !== args.where.id && row.targetFieldId === target?.targetFieldId && row.priority === args.data.priority)
      if (clash) throw Object.assign(new Error("unique violation on priority"), { code: "P2002" })
    }
    return original(args as never)
  }) as never
  return fake
}

describe("admin service", () => {
  let admin: ReturnType<typeof uniqueRuleDb>
  const create = (sourceFieldId: string, extra: Record<string, unknown> = {}) =>
    createInheritanceRule(admin.tx as never, { workspaceId: WS, targetFieldId: "dst", sourceFieldId, ...extra })

  beforeEach(() => {
    admin = uniqueRuleDb()
    for (const id of ["s0", "s1", "s2", "s3"]) admin.addField({ id, workspaceId: WS, objectType: id === "s2" ? "SOLUTION" : "OPPORTUNITY", fieldType: "TEXT", name: id })
    admin.addField({ id: "dst", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "TEXT", name: "Dst" })
  })

  const order = async () => (await listInheritanceRules(admin.tx as never, WS)).map((rule) => `${rule.sourceFieldId}:${rule.priority}`)

  it("a duplicate source/target pair is a friendly InheritanceRuleError, also when the first is disabled", async () => {
    const first = await create("s0")
    await setInheritanceRuleEnabled(admin.tx as never, WS, first.id, false)
    await expect(create("s0")).rejects.toThrow(/already exists/i)
  })

  it("priority after delete + create: the new rule goes to the END, never colliding with a gap", async () => {
    await create("s0"); const middle = await create("s1"); await create("s2")
    await deleteInheritanceRule(admin.tx as never, WS, middle.id)
    expect(await order()).toEqual(["s0:0", "s2:2"])
    await create("s3")
    expect(await order()).toEqual(["s0:0", "s2:2", "s3:3"])
  })

  it("deleting the LAST rule then creating reuses its priority number without a unique clash", async () => {
    await create("s0"); const last = await create("s1")
    await deleteInheritanceRule(admin.tx as never, WS, last.id)
    await create("s2")
    expect(await order()).toEqual(["s0:0", "s2:1"])
  })

  it("moves with three rules: down on top, up on bottom, up on middle, and the ends are no-ops", async () => {
    const a = await create("s0"); const b = await create("s1"); const c = await create("s2")
    await moveInheritanceRule(admin.tx as never, WS, a.id, "up")
    await moveInheritanceRule(admin.tx as never, WS, c.id, "down")
    expect(await order()).toEqual(["s0:0", "s1:1", "s2:2"])

    await moveInheritanceRule(admin.tx as never, WS, a.id, "down")
    expect(await order()).toEqual(["s1:0", "s0:1", "s2:2"])
    await moveInheritanceRule(admin.tx as never, WS, c.id, "up")
    expect(await order()).toEqual(["s1:0", "s2:1", "s0:2"])
    await moveInheritanceRule(admin.tx as never, WS, b.id, "down")
    expect(await order()).toEqual(["s2:0", "s1:1", "s0:2"])
    expect(admin.tables.customFieldInheritanceRule.some((row) => row.priority === -1)).toBe(false)
  })

  it("moves across a priority gap (0, 2, 5) by swapping the numbers", async () => {
    await create("s0", { priority: 0 }); const mid = await create("s1", { priority: 2 }); await create("s2", { priority: 5 })
    await moveInheritanceRule(admin.tx as never, WS, mid.id, "up")
    expect(await order()).toEqual(["s1:0", "s0:2", "s2:5"])
  })

  it("moving a disabled rule works and keeps it disabled", async () => {
    await create("s0"); const b = await create("s1")
    await setInheritanceRuleEnabled(admin.tx as never, WS, b.id, false)
    await moveInheritanceRule(admin.tx as never, WS, b.id, "up")
    expect((await listInheritanceRules(admin.tx as never, WS))[0]).toMatchObject({ sourceFieldId: "s1", enabled: false, status: "disabled" })
  })

  it("a foreign workspace can neither move, toggle nor delete this workspace's rules", async () => {
    const a = await create("s0"); await create("s1")
    await expect(moveInheritanceRule(admin.tx as never, OTHER_WS, a.id, "down")).rejects.toThrow(/not found/i)
    await expect(setInheritanceRuleEnabled(admin.tx as never, OTHER_WS, a.id, false)).rejects.toThrow(/not found/i)
    await expect(deleteInheritanceRule(admin.tx as never, OTHER_WS, a.id)).rejects.toThrow(/not found/i)
    expect(await order()).toEqual(["s0:0", "s1:1"])
  })

  it("deleting a field removes its rules whether it is the TARGET or a SOURCE, and spares other fields' rules", async () => {
    await create("s0"); await create("s1")
    admin.addField({ id: "dst2", workspaceId: WS, objectType: "ROADMAP_ITEM", fieldType: "TEXT", name: "Dst2" })
    await createInheritanceRule(admin.tx as never, { workspaceId: WS, targetFieldId: "dst2", sourceFieldId: "s0" })
    await deleteInheritanceRulesForField(admin.tx as never, WS, "s0")
    expect(admin.tables.customFieldInheritanceRule.map((row) => `${row.targetFieldId}<-${row.sourceFieldId}`)).toEqual(["dst<-s1"])
    await deleteInheritanceRulesForField(admin.tx as never, WS, "dst")
    expect(admin.tables.customFieldInheritanceRule).toEqual([])
  })

  it("a client-supplied priority is validated: whole numbers from 0 to 1000 only", async () => {
    await expect(create("s0", { priority: 1.5 })).rejects.toThrow(/whole number from 0 to 1000/)
    await expect(create("s0", { priority: -1 })).rejects.toThrow(/whole number from 0 to 1000/)
    await expect(create("s0", { priority: 1001 })).rejects.toThrow(/whole number from 0 to 1000/)
  })

  it("so the reorder swap slot (-1) can never collide with a real rule and every move works", async () => {
    await create("s0", { priority: 0 }); await create("s1", { priority: 1 }); const c = await create("s2", { priority: 2 })
    await expect(moveInheritanceRule(admin.tx as never, WS, c.id, "up")).resolves.toBeUndefined()
  })
})
