import { afterEach, describe, expect, it, vi } from "vitest"
import { decodeCursor, encodeCursor } from "@/lib/rest/cursor"

describe("REST cursors", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("binds a cursor to its collection and filters", () => {
    const cursor = encodeCursor({ id: "row-1", createdAt: "2026-10-02T00:00:00.000Z", context: "tasks:workspace:{status:TODO}" })
    expect(decodeCursor(cursor, "tasks:workspace:{status:TODO}")).toMatchObject({ id: "row-1" })
    expect(decodeCursor(cursor, "tasks:workspace:{status:DONE}")).toBeNull()
  })

  it("rejects tampering", () => {
    const cursor = encodeCursor({ id: "row-1", createdAt: "2026-10-02T00:00:00.000Z", context: "tasks" })
    expect(decodeCursor(`${cursor.slice(0, -1)}x`, "tasks")).toBeNull()
  })

  it("fails closed in production without a configured secret", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("REST_CURSOR_SECRET", "")
    vi.stubEnv("MCP_API_KEY", "")
    expect(() => encodeCursor({ id: "row-1", createdAt: "2026-10-02T00:00:00.000Z", context: "tasks" })).toThrow(/must be configured/)
  })
})
