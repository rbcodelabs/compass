import { describe, expect, it } from "vitest"
import {
  SEQ_NUMBER_MAX,
  SEQ_PREFIX_MAX_LENGTH,
  WORK_ITEM_REGISTRY,
  WORK_ITEM_TYPES,
  classifyWorkItemRef,
  displayIdFromRow,
  displayIdMismatchMessage,
  formatDisplayId,
  isWorkItemType,
  parseDisplayId,
  workItemPrefix,
  workItemTypeForPrefix,
} from "@/lib/work-item-ids"

describe("work item registry", () => {
  it("covers exactly the 14 approved types", () => {
    expect(WORK_ITEM_TYPES).toHaveLength(14)
    expect(Object.keys(WORK_ITEM_REGISTRY).sort()).toEqual([...WORK_ITEM_TYPES].sort())
  })

  it("has unique letter-only prefixes that fit seq_prefix", () => {
    const prefixes = WORK_ITEM_TYPES.map(workItemPrefix)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    for (const prefix of prefixes) {
      expect(prefix).toMatch(/^[A-Z]+$/)
      expect(prefix.length).toBeLessThanOrEqual(SEQ_PREFIX_MAX_LENGTH)
    }
  })

  it("has no prefix that is a prefix of another", () => {
    const prefixes = WORK_ITEM_TYPES.map(workItemPrefix)
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a !== b) expect(b.startsWith(a)).toBe(false)
      }
    }
  })

  it("has unique tables", () => {
    const tables = WORK_ITEM_TYPES.map((type) => WORK_ITEM_REGISTRY[type].table)
    expect(new Set(tables).size).toBe(tables.length)
  })

  it("matches the approved prefixes", () => {
    expect(Object.fromEntries(WORK_ITEM_TYPES.map((t) => [t, workItemPrefix(t)]))).toEqual({
      objective: "OBJ",
      keyResult: "KR",
      opportunity: "OPP",
      solution: "SOL",
      assumption: "ASM",
      experiment: "EXP",
      task: "TASK",
      roadmapItem: "RM",
      feedback: "FB",
      reviewRequest: "DEC",
      doc: "DOC",
      artifact: "ART",
      researchStudy: "STUDY",
      metric: "MET",
    })
  })

  it("recognises types and prefixes", () => {
    expect(isWorkItemType("task")).toBe(true)
    expect(isWorkItemType("toString")).toBe(false)
    expect(isWorkItemType(5)).toBe(false)
    expect(workItemTypeForPrefix("opp")).toBe("opportunity")
    expect(workItemTypeForPrefix("NOPE")).toBeNull()
  })
})

describe("formatDisplayId", () => {
  it("joins prefix and number", () => {
    expect(formatDisplayId("task", 113)).toBe("TASK-113")
    expect(formatDisplayId("opportunity", 1)).toBe("OPP-1")
  })

  it("rejects numbers the column cannot hold", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, SEQ_NUMBER_MAX + 1]) {
      expect(() => formatDisplayId("task", bad)).toThrow(RangeError)
    }
    expect(formatDisplayId("task", SEQ_NUMBER_MAX)).toBe(`TASK-${SEQ_NUMBER_MAX}`)
  })
})

describe("displayIdFromRow", () => {
  it("returns null for rows not numbered yet", () => {
    expect(displayIdFromRow("task", { seqPrefix: null, seqNumber: null })).toBeNull()
    expect(displayIdFromRow("task", {})).toBeNull()
  })

  it("prefers the stored prefix and falls back to the registry", () => {
    expect(displayIdFromRow("task", { seqPrefix: "TASK", seqNumber: 4 })).toBe("TASK-4")
    expect(displayIdFromRow("task", { seqNumber: 4 })).toBe("TASK-4")
  })
})

describe("parseDisplayId", () => {
  it("parses case-insensitively and normalises", () => {
    expect(parseDisplayId("opp-42")).toEqual({ type: "opportunity", prefix: "OPP", number: 42 })
    expect(parseDisplayId("  TASK-7 ")).toEqual({ type: "task", prefix: "TASK", number: 7 })
  })

  it("accepts leading zeros", () => {
    expect(parseDisplayId("OPP-007")?.number).toBe(7)
  })

  it("round-trips every type", () => {
    for (const type of WORK_ITEM_TYPES) {
      expect(parseDisplayId(formatDisplayId(type, 12))).toEqual({
        type,
        prefix: workItemPrefix(type),
        number: 12,
      })
    }
  })

  it.each([
    "",
    "OPP",
    "OPP-",
    "-5",
    "OPP-0",
    "OPP-000",
    "OPP-x",
    "OPP-1.5",
    "OPP--1",
    "OPP-+1",
    "OPP 5",
    "OPP-5-6",
    "NOPE-5",
    "TASKS-5",
    "OP-5",
    `OPP-${SEQ_NUMBER_MAX + 1}`,
    "OPP-99999999999999999999999",
  ])("rejects %j", (input) => {
    expect(parseDisplayId(input)).toBeNull()
  })

  it("accepts the largest INT", () => {
    expect(parseDisplayId(`OPP-${SEQ_NUMBER_MAX}`)?.number).toBe(SEQ_NUMBER_MAX)
  })
})

describe("classifyWorkItemRef", () => {
  const uuid = "123e4567-e89b-42d3-a456-426614174000"

  it("treats a UUID as a UUID, lower-cased", () => {
    expect(classifyWorkItemRef(uuid)).toEqual({ kind: "uuid", id: uuid })
    expect(classifyWorkItemRef(uuid.toUpperCase())).toEqual({ kind: "uuid", id: uuid })
  })

  it("treats a display ID as a display ID", () => {
    expect(classifyWorkItemRef("sol-3")).toEqual({
      kind: "display",
      parsed: { type: "solution", prefix: "SOL", number: 3 },
    })
  })

  it("rejects anything else", () => {
    for (const input of ["", "hello", "123e4567", `${uuid}x`, "OPP-0"]) {
      expect(classifyWorkItemRef(input)).toEqual({ kind: "invalid" })
    }
  })
})

describe("displayIdMismatchMessage", () => {
  it("names the real type", () => {
    const parsed = parseDisplayId("TASK-5")!
    expect(displayIdMismatchMessage(parsed)).toBe("TASK-5 is a Task")
  })
})
