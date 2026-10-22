import { describe, expect, it } from "vitest"
import { isDsqlWriteConflict } from "@/lib/dsql-conflict"

describe("isDsqlWriteConflict", () => {
  it.each([
    [{ code: "P2034" }],
    [{ code: "40001" }],
    [{ code: "P2010", meta: { code: "40001" } }],
    [new Error("change conflicts with another transaction OC000")],
    [new Error("could not serialize access due to concurrent update (serialization failure)")],
  ])("recognises %j", (error) => expect(isDsqlWriteConflict(error)).toBe(true))

  it.each([[{ code: "P2002" }], [{ code: "P2025" }], [new Error("connection reset")], [null], [undefined], ["P2034"], [42]])("does not mistake %j for a conflict", (error) => {
    expect(isDsqlWriteConflict(error)).toBe(false)
  })
})
