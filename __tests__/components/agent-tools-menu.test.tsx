import { describe, expect, it } from "vitest"
import { connectorsEnabledFor } from "@/components/agent/tools-menu"

const agents = [
  { id: "a-mine", shared: false },
  { id: "a-shared", shared: true },
]

describe("connectorsEnabledFor", () => {
  it("is on for the built-in agent, picked or followed by default", () => {
    expect(connectorsEnabledFor("builtin", "a-shared", agents)).toBe(true)
    expect(connectorsEnabledFor("", null, agents)).toBe(true)
  })
  it("is on for a personal agent, picked or resolved as the default", () => {
    expect(connectorsEnabledFor("a-mine", null, agents)).toBe(true)
    expect(connectorsEnabledFor("", "a-mine", agents)).toBe(true)
  })
  it("is off for a shared agent, picked or resolved as the default", () => {
    expect(connectorsEnabledFor("a-shared", null, agents)).toBe(false)
    expect(connectorsEnabledFor("", "a-shared", agents)).toBe(false)
  })
  it("fails closed for an agent that is not in the list", () => {
    expect(connectorsEnabledFor("a-unknown", null, agents)).toBe(false)
    expect(connectorsEnabledFor("", "a1")).toBe(false)
  })
})
