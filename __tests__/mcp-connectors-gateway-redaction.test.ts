import { describe, expect, it } from "vitest"
import { jsonRpcMethodOf, safeContentType, upstreamErrorSignalOf } from "@/lib/mcp-connectors/gateway"

const bytes = (value: string) => new TextEncoder().encode(value).buffer as ArrayBuffer

describe("jsonRpcMethodOf", () => {
  it("reads a known method of a single request or the first of a batch", () => {
    expect(jsonRpcMethodOf(bytes('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'))).toBe("tools/list")
    expect(jsonRpcMethodOf(bytes('[{"method":"initialize"},{"method":"x"}]'))).toBe("initialize")
  })

  it("never returns a request-supplied method that is not a known MCP method", () => {
    expect(jsonRpcMethodOf(bytes('{"method":"my-secret-document-name"}'))).toBe("other")
    expect(jsonRpcMethodOf(bytes('{"method":"notifications/initialized"}'))).toBe("notifications/initialized")
  })

  it("does not log a crafted notifications/<letters> method verbatim", () => {
    const crafted = "notifications/" + "abcdefghijklmnopqrstuvwxyzabcdefghijklmn".slice(0, 40)
    expect(jsonRpcMethodOf(bytes(JSON.stringify({ method: crafted })))).toBe("other")
    for (const known of ["initialized", "cancelled", "progress", "roots/list_changed", "resources/updated", "resources/list_changed", "tools/list_changed", "prompts/list_changed", "message"])
      expect(jsonRpcMethodOf(bytes(JSON.stringify({ method: "notifications/" + known })))).toBe("notifications/" + known)
  })

  it("returns null for no body, garbage, or a non-string method", () => {
    expect(jsonRpcMethodOf(undefined)).toBeNull()
    expect(jsonRpcMethodOf(bytes("not json"))).toBeNull()
    expect(jsonRpcMethodOf(bytes('{"method":5}'))).toBeNull()
  })
})

describe("safeContentType", () => {
  it("keeps a known media type without parameters and collapses anything else", () => {
    expect(safeContentType("application/json; charset=utf-8")).toBe("application/json")
    expect(safeContentType("application/x-secret-sk_live_123")).toBe("other")
    expect(safeContentType(null)).toBeNull()
  })
})

describe("upstreamErrorSignalOf", () => {
  const googleDenied = '{"id":5,"jsonrpc":"2.0","result":{"content":[{"text":"The caller does not have permission","type":"text"}],"isError":true}}'

  it("finds an isError result, reporting no code and none of its text", () => {
    expect(upstreamErrorSignalOf(googleDenied)).toEqual({ errorCode: null })
  })

  it("finds a JSON-RPC error object's numeric code, in a batch, and in an SSE stream", () => {
    expect(upstreamErrorSignalOf('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}')).toEqual({ errorCode: -32601 })
    expect(upstreamErrorSignalOf(`[{"result":{"content":[]}},${googleDenied}]`)).toEqual({ errorCode: null })
    expect(upstreamErrorSignalOf(`event: message\ndata: ${googleDenied}\n\n`)).toEqual({ errorCode: null })
  })

  it("logs only codes in the JSON-RPC reserved range -32768..-32000", () => {
    for (const code of [-32768, -32602, -32000]) expect(upstreamErrorSignalOf(JSON.stringify({ error: { code } }))).toEqual({ errorCode: code })
    for (const code of [403, 0, -31999, -32769, 123456789, 1.5]) expect(upstreamErrorSignalOf(JSON.stringify({ error: { code } }))).toEqual({ errorCode: null })
  })

  it("ignores a non-numeric error code", () => {
    expect(upstreamErrorSignalOf('{"error":{"code":"sk_live_secret","message":"x"}}')).toEqual({ errorCode: null })
  })

  it("returns null for a success, an isError of false, truncated or non-JSON text", () => {
    expect(upstreamErrorSignalOf('{"result":{"content":[{"text":"fine"}]}}')).toBeNull()
    expect(upstreamErrorSignalOf('{"result":{"isError":false,"content":[{"text":"fine"}]}}')).toBeNull()
    expect(upstreamErrorSignalOf(googleDenied.slice(0, 60))).toBeNull()
    expect(upstreamErrorSignalOf("<html>403</html>")).toBeNull()
    expect(upstreamErrorSignalOf("")).toBeNull()
  })
})
