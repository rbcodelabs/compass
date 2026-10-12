import { describe, expect, it } from "vitest"
import { AGENT_LIST_COOKIE, parseAgentListOpen } from "@/lib/agent-list-pref"

describe("parseAgentListOpen", () => {
  it("defaults to open when the cookie is absent", () => {
    expect(parseAgentListOpen(undefined)).toBe(true)
  })

  it("is collapsed only for an explicit 0", () => {
    expect(parseAgentListOpen("0")).toBe(false)
    expect(parseAgentListOpen("1")).toBe(true)
  })

  it("treats a garbled value as open rather than hiding the list", () => {
    expect(parseAgentListOpen("")).toBe(true)
    expect(parseAgentListOpen("false")).toBe(true)
  })

  it("uses a cookie-safe name", () => {
    expect(AGENT_LIST_COOKIE).toMatch(/^[a-z_]+$/)
  })
})
