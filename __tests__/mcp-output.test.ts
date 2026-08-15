/**
 * Unit tests for the shared MCP structured-output envelope helper.
 */
import { describe, it, expect } from "vitest"
import { z } from "zod"
import { TOOL_OUTPUT_SCHEMA, ok, fail } from "@/lib/mcp-output"

const schema = z.object(TOOL_OUTPUT_SCHEMA)

describe("mcp-output helper", () => {
  it("ok() preserves the text content block verbatim", () => {
    const r = ok("Hello world", { id: "abc" })
    expect(r.content).toEqual([{ type: "text", text: "Hello world" }])
  })

  it("ok() attaches a structuredContent envelope with ok=true and the payload", () => {
    const payload = { items: [{ id: "1" }], count: 1 }
    const r = ok("listing", payload)
    expect(r.structuredContent).toEqual({
      ok: true,
      message: "listing",
      data: payload,
    })
  })

  it("ok() defaults data to null when omitted", () => {
    const r = ok("done")
    expect(r.structuredContent.data).toBeNull()
  })

  it("fail() sets ok=false, preserves text, and does NOT set isError", () => {
    const r = fail("Feedback item not found.")
    expect(r.content).toEqual([{ type: "text", text: "Feedback item not found." }])
    expect(r.structuredContent.ok).toBe(false)
    expect(r.structuredContent.data).toBeNull()
    expect("isError" in r).toBe(false)
  })

  it("both ok() and fail() outputs validate against TOOL_OUTPUT_SCHEMA", () => {
    expect(schema.safeParse(ok("x", { a: 1 }).structuredContent).success).toBe(true)
    expect(schema.safeParse(ok("x", [1, 2, 3]).structuredContent).success).toBe(true)
    expect(schema.safeParse(ok("x", null).structuredContent).success).toBe(true)
    expect(schema.safeParse(fail("y").structuredContent).success).toBe(true)
  })
})
