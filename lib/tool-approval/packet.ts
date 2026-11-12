import { createHash } from "node:crypto"
import { TOOL_APPROVAL_GATE } from "@/lib/tool-approval/gate"

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export const EFFECT_PACKET_SCHEMA_VERSION = "tool-approval/v1" as const

/** The immutable thing a human approves: exactly what will run, against the state it was computed from. */
export type EffectPacket = {
  schemaVersion: typeof EFFECT_PACKET_SCHEMA_VERSION
  tool: string
  capabilityClass: string
  workspaceId: string
  args: Json
  before: Json
  after: Json
}

/** JSON with sorted object keys and undefined dropped: equal values always serialise identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    )
  }
  return value
}

/** Forces a value through JSON so what is hashed, stored and compared is exactly what a re-read would give. */
export function toJsonValue(value: unknown): Json {
  const text = JSON.stringify(value)
  return text === undefined ? null : (JSON.parse(text) as Json)
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(toJsonValue(a)) === canonicalJson(toJsonValue(b))
}

export function fingerprintOf(requestId: string, decisionCycle: number, revisionNumber: number, packet: unknown): string {
  return createHash("sha256").update(canonicalJson({ requestId, decisionCycle, revisionNumber, packet })).digest("hex")
}

export const receiptKeyOf = (decisionId: string): string => `tool-approval:${decisionId}:v1`

/** Identity of "this tool, this workspace, these arguments", independent of key order. */
export function argsHashOf(tool: string, workspaceId: string, args: unknown): string {
  return createHash("sha256").update(canonicalJson({ tool, workspaceId, args })).digest("hex")
}

/**
 * ReviewRequest.subjectId is a UUID column with a unique (workspace, gate, subjectType, subjectId) index and no spare
 * column to hold a dedupe key, so the key is encoded into a deterministic UUID. `generation` counts earlier requests
 * for the same call: a decided request is never reused, the next call takes the next generation.
 */
export function deterministicSubjectId(workspaceId: string, tool: string, argsHash: string, generation: number): string {
  const hex = createHash("sha256").update(`${TOOL_APPROVAL_GATE}|${workspaceId}|${tool}|${argsHash}|${generation}`).digest("hex")
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Parses a stored packet; null if it is not a well-formed v1 packet (the executor treats that as tampering). */
export function parseEffectPacket(raw: string): EffectPacket | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const p = value as Record<string, unknown>
  if (p.schemaVersion !== EFFECT_PACKET_SCHEMA_VERSION) return null
  if (typeof p.tool !== "string" || typeof p.capabilityClass !== "string" || typeof p.workspaceId !== "string") return null
  if (!("args" in p) || !("before" in p) || !("after" in p)) return null
  return p as unknown as EffectPacket
}
