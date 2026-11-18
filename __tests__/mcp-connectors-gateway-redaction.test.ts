import { describe, expect, it } from "vitest"
import { UPSTREAM_ERROR_LOG_CHARS, jsonRpcMethodOf, redactUpstreamExcerpt, toolErrorTextOf, toolNameOf } from "@/lib/mcp-connectors/gateway"

const bytes = (value: string) => new TextEncoder().encode(value).buffer as ArrayBuffer

describe("redactUpstreamExcerpt", () => {
  it("removes the live bearer wherever it appears, and known credential shapes", () => {
    const out = redactUpstreamExcerpt(
      'Bearer abc.def-123 sent; again live-token-value; ya29.A0Afoo-bar; {"access_token":"zzz","client_secret":"yyy"}; eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      ["live-token-value"],
    )
    for (const leaked of ["abc.def-123", "live-token-value", "ya29", "zzz", "yyy", "eyJhbGci"]) expect(out).not.toContain(leaked)
    expect(out).toContain("[redacted]")
  })

  it("redacts before truncating, so a token at the limit leaves no prefix behind", () => {
    const token = "SECRETTOKEN".repeat(5)
    const out = redactUpstreamExcerpt("x".repeat(UPSTREAM_ERROR_LOG_CHARS - 10) + token, [token])
    expect(out).not.toContain("SECRETTOKEN")
    expect(out.length).toBeLessThanOrEqual(UPSTREAM_ERROR_LOG_CHARS)
  })

  it("collapses whitespace and ignores trivially short secrets", () => {
    expect(redactUpstreamExcerpt("a\n\n  b\tc", ["ab"])).toBe("a b c")
  })
})

describe("jsonRpcMethodOf", () => {
  it("reads the method of a single request or the first of a batch", () => {
    expect(jsonRpcMethodOf(bytes('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'))).toBe("tools/list")
    expect(jsonRpcMethodOf(bytes('[{"method":"initialize"},{"method":"x"}]'))).toBe("initialize")
  })

  it("returns null for no body, garbage, or a non-string method", () => {
    expect(jsonRpcMethodOf(undefined)).toBeNull()
    expect(jsonRpcMethodOf(bytes("not json"))).toBeNull()
    expect(jsonRpcMethodOf(bytes('{"method":5}'))).toBeNull()
  })
})

describe("toolNameOf", () => {
  it("reads params.name of a tools/call, and nothing for other requests", () => {
    expect(toolNameOf(bytes('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_files","arguments":{}}}'))).toBe("search_files")
    expect(toolNameOf(bytes('{"method":"tools/list","params":{"name":"x"}}'))).toBeNull()
    expect(toolNameOf(bytes('{"method":"tools/call","params":{"name":5}}'))).toBeNull()
    expect(toolNameOf(undefined)).toBeNull()
    expect(toolNameOf(bytes("nope"))).toBeNull()
  })
})

describe("toolErrorTextOf", () => {
  const googleDenied = '{"id":5,"jsonrpc":"2.0","result":{"content":[{"text":"The caller does not have permission","type":"text"}],"isError":true}}'

  it("finds an isError result, joining its text parts", () => {
    expect(toolErrorTextOf(googleDenied)).toBe("The caller does not have permission")
    expect(toolErrorTextOf('{"result":{"isError":true,"content":[{"text":"a"},{"type":"image"},{"text":"b"}]}}')).toBe("a b")
    expect(toolErrorTextOf('{"result":{"isError":true}}')).toBe("(tool error with no text)")
  })

  it("finds a JSON-RPC error object, in a batch, and in an SSE stream", () => {
    expect(toolErrorTextOf('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}')).toBe("[-32601] Method not found")
    expect(toolErrorTextOf(`[{"result":{"content":[]}},${googleDenied}]`)).toBe("The caller does not have permission")
    expect(toolErrorTextOf(`event: message\ndata: ${googleDenied}\n\n`)).toBe("The caller does not have permission")
  })

  it("returns null for a success, an isError of false, truncated or non-JSON text", () => {
    expect(toolErrorTextOf('{"result":{"content":[{"text":"fine"}]}}')).toBeNull()
    expect(toolErrorTextOf('{"result":{"isError":false,"content":[{"text":"fine"}]}}')).toBeNull()
    expect(toolErrorTextOf(googleDenied.slice(0, 60))).toBeNull()
    expect(toolErrorTextOf("<html>403</html>")).toBeNull()
    expect(toolErrorTextOf("")).toBeNull()
  })
})
