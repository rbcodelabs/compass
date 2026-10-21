import { describe, expect, it } from "vitest"
import {
  DEFAULT_OPPORTUNITY_COLUMN_ORDER, MAX_COLUMN_KEYS, columnLayoutSchema, columnsByGroupSchema, resolveColumns,
} from "@/lib/saved-views/columns"

const STATUSES = ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE"]
const DEFAULT = [...DEFAULT_OPPORTUNITY_COLUMN_ORDER]
const NO_CARDS = {}

describe("DEFAULT_OPPORTUNITY_COLUMN_ORDER", () => {
  it("is Active, Prioritized, Validating, Exploring", () => {
    expect(DEFAULT).toEqual(["ACTIVE", "PRIORITIZED", "VALIDATING", "EXPLORING"])
  })
})

describe("resolveColumns", () => {
  it("uses the default order with no layout", () => {
    const r = resolveColumns(undefined, STATUSES, DEFAULT, NO_CARDS)
    expect(r.order).toEqual(DEFAULT)
    expect(r.visible).toEqual(DEFAULT)
    expect(r.forcedVisible).toEqual([])
  })

  it("honours a complete saved order", () => {
    const r = resolveColumns({ order: ["EXPLORING", "ACTIVE", "VALIDATING", "PRIORITIZED"] }, STATUSES, DEFAULT, NO_CARDS)
    expect(r.order).toEqual(["EXPLORING", "ACTIVE", "VALIDATING", "PRIORITIZED"])
  })

  it("appends statuses missing from the saved order, in default order", () => {
    const r = resolveColumns({ order: ["EXPLORING", "VALIDATING"] }, STATUSES, DEFAULT, NO_CARDS)
    expect(r.order).toEqual(["EXPLORING", "VALIDATING", "ACTIVE", "PRIORITIZED"])
  })

  it("drops unknown keys and de-duplicates", () => {
    const r = resolveColumns({ order: ["GONE", "ACTIVE", "ACTIVE", "EXPLORING"], hidden: ["GONE"] }, STATUSES, DEFAULT, NO_CARDS)
    expect(r.order).toEqual(["ACTIVE", "EXPLORING", "PRIORITIZED", "VALIDATING"])
    expect(r.visible).toEqual(r.order)
  })

  it("hides a hidden column with no cards but keeps it in order", () => {
    const r = resolveColumns({ hidden: ["EXPLORING"] }, STATUSES, DEFAULT, { EXPLORING: 0 })
    expect(r.order).toContain("EXPLORING")
    expect(r.visible).not.toContain("EXPLORING")
    expect(r.forcedVisible).toEqual([])
  })

  it("forces a hidden column visible when it has cards", () => {
    const r = resolveColumns({ hidden: ["EXPLORING", "ACTIVE"] }, STATUSES, DEFAULT, { EXPLORING: 3, ACTIVE: 0 })
    expect(r.forcedVisible).toEqual(["EXPLORING"])
    expect(r.visible).toEqual(["PRIORITIZED", "VALIDATING", "EXPLORING"])
  })

  it("can hide every column when none has cards", () => {
    const r = resolveColumns({ hidden: STATUSES }, STATUSES, DEFAULT, NO_CARDS)
    expect(r.visible).toEqual([])
  })

  it("handles custom-field columns with a __none__ bucket and no default order", () => {
    const keys = ["opt-a", "opt-b", "__none__"]
    const r = resolveColumns({ order: ["opt-b"], hidden: ["__none__"] }, keys, [], { __none__: 2 })
    expect(r.order).toEqual(["opt-b", "opt-a", "__none__"])
    expect(r.visible).toEqual(["opt-b", "opt-a", "__none__"])
    expect(r.forcedVisible).toEqual(["__none__"])
  })

  it("places keys the default order omits after the ones it names", () => {
    expect(resolveColumns(undefined, ["x", "y", "z"], ["z"], NO_CARDS).order).toEqual(["z", "x", "y"])
  })
})

describe("column layout schemas", () => {
  it("defaults an empty layout", () => {
    expect(columnLayoutSchema.parse({})).toEqual({ order: [], hidden: [] })
    expect(columnsByGroupSchema.parse(undefined)).toEqual({})
  })

  it("caps list length", () => {
    const tooMany = Array.from({ length: MAX_COLUMN_KEYS + 1 }, (_, i) => `k${i}`)
    expect(columnLayoutSchema.safeParse({ order: tooMany }).success).toBe(false)
    expect(columnLayoutSchema.safeParse({ hidden: tooMany }).success).toBe(false)
  })
})
