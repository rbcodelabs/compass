import { describe, expect, it } from "vitest"
import { connectorsEnabledFor } from "@/components/agent/tools-menu"

describe("connectorsEnabledFor", () => {
  it("is on only for the built-in agent", () => {
    expect(connectorsEnabledFor("builtin", "a1")).toBe(true)
    expect(connectorsEnabledFor("", null)).toBe(true)
  })
  it("is off for a picked agent or a resolved default agent", () => {
    expect(connectorsEnabledFor("a-mine", null)).toBe(false)
    expect(connectorsEnabledFor("", "a1")).toBe(false)
  })
})
