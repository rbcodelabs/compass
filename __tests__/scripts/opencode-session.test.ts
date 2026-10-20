import { describe, expect, it } from "vitest"
import { gzipSync } from "node:zlib"
import { packOpencodeSession, sessionIdFromExport, unpackOpencodeSession } from "../../scripts/agent/opencode-adapter"

describe("opencode session transcript packing", () => {
  const exported = JSON.stringify({ info: { id: "ses_abc" }, messages: [{ info: { id: "msg_1" }, parts: [] }] })

  it("round-trips an opencode export and exposes its session id", () => {
    const gz = packOpencodeSession(exported)
    expect(JSON.parse(unpackOpencodeSession(gz)!)).toEqual(JSON.parse(exported))
    expect(sessionIdFromExport(exported)).toBe("ses_abc")
    expect(sessionIdFromExport("{}")).toBeUndefined()
    expect(sessionIdFromExport("not json")).toBeUndefined()
  })

  it("refuses a Claude transcript (gzipped JSONL) so a harness switch falls back to replay", () => {
    const claude = gzipSync(Buffer.from(`${JSON.stringify({ s: null, e: { type: "user", uuid: "u" } })}\n`))
    expect(unpackOpencodeSession(claude)).toBeUndefined()
  })

  it("refuses garbage, a wrong format tag and a wrong harness tag", () => {
    expect(unpackOpencodeSession(Buffer.from("not gzip"))).toBeUndefined()
    expect(unpackOpencodeSession(gzipSync(Buffer.from(JSON.stringify({ format: "other/1", harness: "opencode", export: {} }))))).toBeUndefined()
    expect(unpackOpencodeSession(gzipSync(Buffer.from(JSON.stringify({ format: "compass-opencode-session/1", harness: "claude", export: {} }))))).toBeUndefined()
  })
})
