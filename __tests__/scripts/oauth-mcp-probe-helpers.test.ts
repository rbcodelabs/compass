import { describe, expect, it } from "vitest"

import {
  mcpErrorText,
  mcpToolEnvelope,
  parseMcpPayload,
  runCleanupStack,
} from "../../scripts/oauth-mcp-probe-helpers"

const toolPayload = {
  jsonrpc: "2.0",
  id: 7,
  result: {
    content: [{ type: "text", text: "Current authenticated identity" }],
    structuredContent: {
      ok: true,
      message: "Current authenticated identity",
      data: { purpose: "AGENT", agent: { id: "agent-1", name: "Probe agent" } },
    },
  },
}

describe("parseMcpPayload", () => {
  it("parses an application/json MCP response", () => {
    expect(parseMcpPayload(JSON.stringify(toolPayload))).toEqual(toolPayload)
  })

  it("parses the JSON-RPC event from a streamable HTTP response", () => {
    const body = [
      "event: message",
      `data: ${JSON.stringify(toolPayload)}`,
      "",
    ].join("\n")
    expect(parseMcpPayload(body)).toEqual(toolPayload)
  })

  it("rejects a response with no JSON-RPC payload without echoing secrets", () => {
    expect(() => parseMcpPayload("event: ping\ndata: not-json\n")).toThrow(
      "MCP response contained no JSON-RPC payload",
    )
  })
})

describe("mcpToolEnvelope", () => {
  it("returns the structured tool result", () => {
    expect(mcpToolEnvelope(toolPayload)).toEqual(toolPayload.result.structuredContent)
  })

  it("returns null for a JSON-RPC error", () => {
    expect(mcpToolEnvelope({ jsonrpc: "2.0", id: 7, error: { code: -1, message: "denied" } })).toBeNull()
  })
})

describe("mcpErrorText", () => {
  it("reads SDK tool errors from content blocks", () => {
    expect(
      mcpErrorText({
        jsonrpc: "2.0",
        id: 8,
        result: { isError: true, content: [{ type: "text", text: "Human administrator required." }] },
      }),
    ).toBe("Human administrator required.")
  })

  it("reads JSON-RPC error messages", () => {
    expect(
      mcpErrorText({ jsonrpc: "2.0", id: 9, error: { code: -32000, message: "Unauthorized" } }),
    ).toBe("Unauthorized")
  })
})

describe("runCleanupStack", () => {
  it("runs every cleanup in reverse registration order", async () => {
    const calls: string[] = []
    const failures = await runCleanupStack([
      async () => { calls.push("database") },
      async () => { calls.push("oauth") },
      async () => { calls.push("fixture") },
    ])

    expect(calls).toEqual(["fixture", "oauth", "database"])
    expect(failures).toEqual([])
  })

  it("continues after a cleanup fails and returns the failures", async () => {
    const calls: string[] = []
    const failure = new Error("fixture cleanup failed")
    const failures = await runCleanupStack([
      async () => { calls.push("database") },
      async () => { calls.push("oauth"); throw failure },
      async () => { calls.push("fixture") },
    ])

    expect(calls).toEqual(["fixture", "oauth", "database"])
    expect(failures).toEqual([failure])
  })
})
