import { describe, expect, it } from "vitest"
import { TOOL_APPROVAL_GATE, excludeToolApprovals, isToolApprovalGate, toolApprovalPath } from "@/lib/tool-approval/gate"
import { argsHashOf, canonicalJson, deterministicSubjectId, fingerprintOf, parseEffectPacket, receiptKeyOf, sameJson, toJsonValue, type EffectPacket } from "@/lib/tool-approval/packet"

const packet = (over: Partial<EffectPacket> = {}): EffectPacket => ({
  schemaVersion: "tool-approval/v1", tool: "t", capabilityClass: "c", workspaceId: "w", args: { a: 1 }, before: { x: [1] }, after: { x: [1, 2] }, ...over,
})

describe("tool approval gate helpers", () => {
  it("names the gate and builds the dedicated approval path", () => {
    expect(TOOL_APPROVAL_GATE).toBe("TOOL_APPROVAL")
    expect(isToolApprovalGate("TOOL_APPROVAL")).toBe(true)
    expect(isToolApprovalGate("TRACKED_DECISION")).toBe(false)
    expect(toolApprovalPath("acme", "product", "req-1")).toBe("/acme/product/approvals/req-1")
    expect(excludeToolApprovals).toEqual({ gateType: { not: "TOOL_APPROVAL" } })
  })
})

describe("canonical JSON and fingerprints", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[2,{"y":2,"z":1}]},"b":1}')
    expect(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false)
  })
  it("toJsonValue round-trips non-JSON values", () => {
    expect(toJsonValue({ a: undefined, b: new Date("2026-01-01T00:00:00Z") })).toEqual({ b: "2026-01-01T00:00:00.000Z" })
    expect(toJsonValue(undefined)).toBeNull()
  })
  it("fingerprint binds request, cycle, revision and every packet field", () => {
    const base = fingerprintOf("r", 1, 1, packet())
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprintOf("r", 1, 1, packet())).toBe(base)
    expect(fingerprintOf("r2", 1, 1, packet())).not.toBe(base)
    expect(fingerprintOf("r", 2, 1, packet())).not.toBe(base)
    expect(fingerprintOf("r", 1, 2, packet())).not.toBe(base)
    for (const over of [{ tool: "u" }, { capabilityClass: "d" }, { workspaceId: "w2" }, { args: { a: 2 } }, { before: {} }, { after: {} }] as const) {
      expect(fingerprintOf("r", 1, 1, packet(over))).not.toBe(base)
    }
  })
  it("receipt key is per decision", () => expect(receiptKeyOf("d1")).toBe("tool-approval:d1:v1"))
})

describe("deterministic subject ids", () => {
  it("is a stable uuid per (workspace, tool, args hash, generation)", () => {
    const hash = argsHashOf("t", "w", { a: 1 })
    expect(argsHashOf("t", "w", { a: 1 })).toBe(hash)
    expect(argsHashOf("t", "w", { a: 2 })).not.toBe(hash)
    expect(argsHashOf("u", "w", { a: 1 })).not.toBe(hash)
    expect(argsHashOf("t", "w2", { a: 1 })).not.toBe(hash)
    const id = deterministicSubjectId("w", "t", hash, 0)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(deterministicSubjectId("w", "t", hash, 0)).toBe(id)
    expect(deterministicSubjectId("w", "t", hash, 1)).not.toBe(id)
  })
})

describe("parseEffectPacket", () => {
  it("accepts a well-formed packet", () => expect(parseEffectPacket(JSON.stringify(packet()))).toEqual(packet()))
  it("rejects wrong version, missing fields and garbage", () => {
    expect(parseEffectPacket("not json")).toBeNull()
    expect(parseEffectPacket(JSON.stringify({ ...packet(), schemaVersion: "v0" }))).toBeNull()
    expect(parseEffectPacket(JSON.stringify({ ...packet(), tool: undefined }))).toBeNull()
    expect(parseEffectPacket(JSON.stringify({ ...packet(), workspaceId: 3 }))).toBeNull()
    expect(parseEffectPacket("[]")).toBeNull()
    expect(parseEffectPacket("null")).toBeNull()
  })
})
