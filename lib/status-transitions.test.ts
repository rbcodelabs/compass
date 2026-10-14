import { describe, expect, it } from "vitest"
import { detectFieldTransitions } from "./status-transitions"

describe("detectFieldTransitions", () => {
  it("reports a status change with its before and after values", () => {
    expect(detectFieldTransitions("task", { status: "TODO" }, { status: "DONE" })).toEqual([{ field: "status", from: "TODO", to: "DONE" }])
  })

  it("reports nothing for a repeated status or an unrelated edit", () => {
    expect(detectFieldTransitions("task", { status: "TODO" }, { status: "TODO" })).toEqual([])
    expect(detectFieldTransitions("opportunity", { status: "OPEN" }, { status: "OPEN" })).toEqual([])
  })

  it("ignores a status the mutation result does not carry", () => {
    expect(detectFieldTransitions("task", { status: "TODO" }, {})).toEqual([])
  })

  it("treats a create (no before row) as a transition from nothing", () => {
    expect(detectFieldTransitions("task", null, { status: "TODO" })).toEqual([{ field: "status", from: undefined, to: "TODO" }])
  })

  it("tracks horizon beside status for roadmap items only", () => {
    expect(detectFieldTransitions("roadmapItem", { status: "ACTIVE", horizon: "LATER" }, { status: "ACTIVE", horizon: "NEXT" })).toEqual([{ field: "horizon", from: "LATER", to: "NEXT" }])
    expect(detectFieldTransitions("roadmapItem", { status: "ACTIVE", horizon: "LATER" }, { status: "DONE", horizon: "NEXT" }).map((t) => t.field)).toEqual(["status", "horizon"])
    expect(detectFieldTransitions("task", { status: "TODO", horizon: "A" } as never, { status: "TODO", horizon: "B" } as never)).toEqual([])
  })
})
