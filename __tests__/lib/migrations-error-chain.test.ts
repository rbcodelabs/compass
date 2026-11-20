import { describe, expect, it } from "vitest"
import { describeInspectionFailure } from "@/lib/migrations/error-chain"

describe("public migration inspection diagnostics", () => {
  it.each([
    ["ECONNREFUSED", "CONNECTION"], ["P1001", "CONNECTION"], ["P2021", "SCHEMA"],
    ["42501", "PERMISSION"], ["57014", "TIMEOUT"], ["P2028", "TIMEOUT"],
  ])("exposes only fixed code %s and its category", (code, category) => {
    expect(describeInspectionFailure({ code, message: "unlabelled secret", name: "private name", meta: { arbitrary: "private record" } })).toEqual({ code, category })
  })

  it.each([undefined, "private secret", { code: "private secret" }, { code: "toString" }])("omits arbitrary error content %j", (error) => {
    expect(describeInspectionFailure(error)).toEqual({ category: "UNKNOWN" })
  })

  it("recognizes nested codes without exposing messages or adapter metadata", () => {
    expect(describeInspectionFailure({ meta: { driverAdapterError: { cause: { code: "ECONNRESET", detail: "private record" } } } })).toEqual({ category: "CONNECTION", code: "ECONNRESET" })
    expect(describeInspectionFailure(new AggregateError([{ code: "42501", message: "private" }], "private"))).toEqual({ category: "PERMISSION", code: "42501" })
  })

  it("terminates cyclic chains while preserving repeated sibling inspection", () => {
    const circular: { cause?: unknown } = {}
    circular.cause = circular
    expect(describeInspectionFailure(circular)).toEqual({ category: "UNKNOWN" })
    expect(describeInspectionFailure({ errors: [circular, circular, { code: "P1001" }] })).toEqual({ category: "CONNECTION", code: "P1001" })
  })

  it("bounds cause depth and aggregate members", () => {
    let deep: unknown = { code: "P1001" }
    for (let i = 0; i < 5; i++) deep = { cause: deep }
    expect(describeInspectionFailure(deep)).toEqual({ category: "UNKNOWN" })
    expect(describeInspectionFailure({ errors: [...Array.from({ length: 5 }, () => ({})), { code: "P1001" }] })).toEqual({ category: "UNKNOWN" })
  })

  it("does not expose or propagate a throwing error getter", () => {
    expect(describeInspectionFailure({ get code() { throw new Error("private getter content") } })).toEqual({ category: "UNKNOWN" })
  })
})
