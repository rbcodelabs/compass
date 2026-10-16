import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db", () => ({ default: () => ({}) }))

import { McpConnectorError } from "@/lib/mcp-connectors/config"
import { parseRpcBody, parseToolResult } from "@/lib/mcp-connectors/call"

describe("connector call parsing", () => {
  it("picks the reply matching the request id from JSON and SSE bodies", () => {
    expect(parseRpcBody('{"jsonrpc":"2.0","id":2,"result":{"ok":1}}', "application/json", 2)).toMatchObject({ result: { ok: 1 } })
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":2}}\n\n'
    expect(parseRpcBody(sse, "text/event-stream", 2)).toMatchObject({ result: { ok: 2 } })
    expect(parseRpcBody(sse, "text/event-stream", 9)).toBeNull()
    expect(parseRpcBody("  ", "application/json", 1)).toBeNull()
    expect(() => parseRpcBody("<html>", "text/html", 1)).toThrow(McpConnectorError)
  })

  it("prefers structuredContent, falls back to JSON text, and surfaces tool errors", () => {
    expect(parseToolResult({ result: { structuredContent: { a: 1 }, content: [] } }, "getChat").structured).toEqual({ a: 1 })
    expect(parseToolResult({ result: { content: [{ type: "text", text: '{"b":2}' }] } }, "getChat").structured).toEqual({ b: 2 })
    expect(() => parseToolResult({ result: { isError: true, content: [{ type: "text", text: "no such chat" }] } }, "getChat")).toThrow(/no such chat/)
    expect(() => parseToolResult({ error: { message: "boom" } }, "getChat")).toThrow(/boom/)
    expect(() => parseToolResult(null, "getChat")).toThrow(/no reply/)
  })
})
