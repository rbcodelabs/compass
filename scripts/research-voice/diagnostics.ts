// Schema-owned paths only. Never enumerate provider keys or serialize its values.
const fields = {
  type: ["realtime"],
  model: ["gpt-realtime-2.1", "gpt-realtime", "gpt-realtime-mini"],
  tools: "count",
  tool_choice: ["none", "auto", "required"],
  output_modalities: ["audio", "text", "audio.text", "text.audio", "EMPTY"],
  max_output_tokens: "number",
  instructions: "private",
  audio: "container",
  "audio.input": "container",
  "audio.input.transcription": "container",
  "audio.input.transcription.model": ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"],
  "audio.input.transcription.language": ["en"],
  "audio.input.turn_detection": "container",
  "audio.input.turn_detection.type": ["server_vad", "semantic_vad"],
  "audio.input.turn_detection.create_response": "boolean",
  "audio.input.turn_detection.interrupt_response": "boolean",
  "audio.output": "container",
  "audio.output.voice": ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"],
  "session.id": "private",
} as const
type Field = keyof typeof fields
type EventKind = "session.created" | "session.updated"
type Diagnostic = Record<string, unknown>
const types = ["missing", "null", "array", "object", "string", "number", "boolean"]
const typeOf = (value: unknown) => value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value
const safeNumber = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000

function safeValue(field: Field, value: unknown): string | number | boolean | undefined {
  const rule = fields[field]
  if (rule === "private" || rule === "container" || rule === "count") return undefined
  if (rule === "boolean") return typeof value === "boolean" ? value : "REDACTED"
  if (rule === "number") return safeNumber(value) ? value as number : value === "inf" ? "inf" : "REDACTED"
  if (field === "output_modalities" && Array.isArray(value)) {
    // Check individual values before joining; never stringify arbitrary contents.
    value = value.length <= 2 && value.every((item) => item === "audio" || item === "text") ? value.join(".") || "EMPTY" : "REDACTED"
  }
  return typeof value === "string" && (rule as readonly string[]).includes(value) ? value : "REDACTED"
}

export function policyDiagnostics(actual: Record<string, unknown>, expected: Record<string, unknown>, eventKind: EventKind, identityMatches?: boolean): Diagnostic[] {
  const entries: Diagnostic[] = []
  function visit(field: string, value: unknown, wanted: unknown) {
    if (!Object.hasOwn(fields, field)) return
    const known = field as Field
    const actualType = typeOf(value); const expectedType = typeOf(wanted)
    if (expectedType === "object" && actualType === "object") {
      for (const [key, child] of Object.entries(wanted as Record<string, unknown>)) visit(`${field}.${key}`, (value as Record<string, unknown>)[key], child)
      return
    }
    const equal = expectedType === "array" && actualType === "array"
      ? (value as unknown[]).length === (wanted as unknown[]).length && (wanted as unknown[]).every((item, index) => item === (value as unknown[])[index])
      : value === wanted
    if (equal) return
    const entry: Diagnostic = { kind: "policy_mismatch", eventKind, field, mismatch: actualType === "missing" ? "missing" : actualType !== expectedType ? "type" : "value", expectedType, actualType }
    if (fields[known] === "private") entry.equal = false
    else if (fields[known] === "count") {
      if (Array.isArray(wanted)) entry.expectedCount = wanted.length
      if (Array.isArray(value)) entry.actualCount = value.length
    } else {
      const expectedValue = safeValue(known, wanted); const actualValue = safeValue(known, value)
      if (expectedValue !== undefined) entry.expectedValue = expectedValue
      if (actualValue !== undefined) entry.actualValue = actualValue
    }
    entries.push(entry)
  }
  for (const [key, value] of Object.entries(expected)) visit(key, actual[key], value)
  if (typeof actual.id !== "string") entries.push({ kind: "policy_mismatch", eventKind, field: "session.id", mismatch: actual.id === undefined ? "missing" : "type", expectedType: "string", actualType: typeOf(actual.id), equal: false })
  else if (identityMatches === false) entries.push({ kind: "policy_mismatch", eventKind, field: "session.id", mismatch: "value", expectedType: "string", actualType: "string", equal: false })
  return entries // bounded by the 21 schema-owned paths, irrespective of provider extras
}

export function validatePolicyDiagnostic(entry: Diagnostic): void {
  const keys = ["kind", "eventKind", "field", "mismatch", "expectedType", "actualType", "expectedValue", "actualValue", "expectedCount", "actualCount", "equal"]
  const field = entry.field
  if (entry.kind !== "policy_mismatch" || typeof field !== "string" || !Object.hasOwn(fields, field) ||
    !["session.created", "session.updated"].includes(String(entry.eventKind)) ||
    !["missing", "type", "value"].includes(String(entry.mismatch)) ||
    !types.includes(String(entry.expectedType)) || !types.includes(String(entry.actualType)) ||
    Object.keys(entry).some((key) => !keys.includes(key))) throw new Error("UNSAFE_POLICY_DIAGNOSTIC")
  const rule = fields[field as Field]
  for (const key of ["expectedValue", "actualValue"]) {
    if (key in entry && (entry[key] === undefined || (entry[key] !== "REDACTED" && safeValue(field as Field, entry[key]) !== entry[key]) || ["private", "container", "count"].includes(rule as string))) throw new Error("UNSAFE_POLICY_DIAGNOSTIC")
  }
  for (const key of ["expectedCount", "actualCount"]) if (key in entry && (rule !== "count" || !safeNumber(entry[key]))) throw new Error("UNSAFE_POLICY_DIAGNOSTIC")
  if ("equal" in entry && (rule !== "private" || entry.equal !== false)) throw new Error("UNSAFE_POLICY_DIAGNOSTIC")
}
