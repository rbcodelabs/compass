import { describe, expect, it, vi } from "vitest"
import { probePolicy, ProbeProtocol } from "@/scripts/research-voice/protocol"
import { ProbeJournal } from "@/scripts/research-voice/journal"
import { validatePolicyDiagnostic } from "@/scripts/research-voice/diagnostics"
import { observeProbeSocket } from "@/scripts/research-voice/worker"
import { collectWorkerLogs, WorkerEvidence } from "@/scripts/research-voice/evidence"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function mismatch(change: (session: Record<string, unknown>) => void) {
  const record = vi.fn()
  const parser = new ProbeProtocol("diagnostic-run", record)
  const session: Record<string, unknown> = { ...probePolicy("diagnostic-run"), id: "private-session-id" }
  change(session)
  expect(() => parser.accept(JSON.stringify({ type: "session.created", session }))).toThrow("POLICY_MISMATCH")
  expect(parser.ready()).toBe(false)
  expect(parser.policyAcknowledged()).toBe(false)
  return record.mock.calls.map(([entry]) => entry as Record<string, unknown>)
}

describe("safe policy mismatch diagnostics", () => {
  it("carries actual worker mismatch output through split stdout chunks into the validated journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-log-transport-"))
    const path = join(dir, "attempt.jsonl"); const journal = new ProbeJournal(path)
    try {
      let stdout = ""
      const record = (entry: Record<string, unknown>) => { stdout += JSON.stringify(entry) + "\n" }
      const socket = Object.assign(new EventTarget(), { send: vi.fn(), close: vi.fn() })
      const parser = new ProbeProtocol("transport-run", record)
      const observation = observeProbeSocket(socket as unknown as Parameters<typeof observeProbeSocket>[0], parser, "transport-run", Date.now() + 1000, record)
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "session.created", session: { ...probePolicy("transport-run"), id: "private-session", instructions: "private-instructions", model: "sk-private-model" } }) }))
      await expect(observation).rejects.toThrow("POLICY_MISMATCH")
      record({ kind: "provider_stop", status: "STOPPED" })
      record({ kind: "failure", code: "POLICY_MISMATCH" })
      async function* lines() {
        yield { stream: "stderr", data: "private-stderr" }
        for (let offset = 0; offset < stdout.length; offset += 23) yield { stream: "stdout", data: stdout.slice(offset, offset + 23) }
      }
      const evidence = new WorkerEvidence()
      await expect(collectWorkerLogs(lines(), (entry) => journal.record(entry), evidence)).rejects.toThrow("POLICY_MISMATCH")
      const saved = readFileSync(path, "utf8")
      expect(saved).toContain('"field":"model"')
      expect(saved).toContain('"field":"instructions"')
      expect(saved).not.toContain("private")
      expect(() => evidence.ready()).toThrow("POLICY_MISMATCH")
      expect(evidence.providerStopped()).toBe(true)
    } finally { journal.close(); rmSync(dir, { recursive: true }) }
  })
  it("names a missing approved field without weakening the strict comparison", () => {
    expect(mismatch((session) => { delete session.max_output_tokens })).toContainEqual(expect.objectContaining({
      kind: "policy_mismatch", eventKind: "session.created", field: "max_output_tokens", mismatch: "missing", expectedType: "number", actualType: "missing", expectedValue: 128,
    }))
  })
  it("distinguishes a wrong container type from a missing leaf", () => {
    expect(mismatch((session) => { session.audio = "private-string" })).toEqual([expect.objectContaining({ field: "audio", mismatch: "type", actualType: "string" })])
  })
  it("records safe typed output limit and approved enum values", () => {
    expect(mismatch((session) => { session.max_output_tokens = 4096; session.tool_choice = "auto" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "max_output_tokens", mismatch: "value", expectedValue: 128, actualValue: 4096 }),
      expect.objectContaining({ field: "tool_choice", mismatch: "value", expectedValue: "none", actualValue: "auto" }),
    ]))
  })
  it("identifies nested voice and automatic response changes with safe typed values", () => {
    const entries = mismatch((session) => {
      const audio = session.audio as ReturnType<typeof probePolicy>["audio"]
      audio.output.voice = "cedar"
      audio.input.turn_detection.create_response = true
      audio.input.transcription.model = "unknown-private-model"
    })
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "audio.output.voice", actualValue: "cedar" }),
      expect.objectContaining({ field: "audio.input.turn_detection.create_response", expectedValue: false, actualValue: true }),
      expect.objectContaining({ field: "audio.input.transcription.model", actualValue: "REDACTED" }),
    ]))
    entries.forEach(validatePolicyDiagnostic)
    expect(JSON.stringify(entries)).not.toContain("private")
  })
  it("bounds diagnostics to known paths without traversing untrusted tools or extra fields", () => {
    const entries = mismatch((session) => {
      session.tools = Array.from({ length: 200 }, () => ({ name: "secret-tool", instructions: "secret" }))
      for (let index = 0; index < 500; index++) session[`secret-field-${index}`] = "secret"
      session.output_modalities = ["secret-modality"]
      session.max_output_tokens = -1e200
    })
    expect(entries).toHaveLength(3)
    expect(entries).toContainEqual(expect.objectContaining({ field: "tools", actualCount: 200 }))
    expect(entries).toContainEqual(expect.objectContaining({ field: "max_output_tokens", actualValue: "REDACTED" }))
    expect(entries).toContainEqual(expect.objectContaining({ field: "output_modalities", actualValue: "REDACTED" }))
    entries.forEach(validatePolicyDiagnostic)
    expect(JSON.stringify(entries).length).toBeLessThan(2000)
    expect(JSON.stringify(entries)).not.toContain("secret")
  })
  it.each(["instructions", "session.id", "tools", "audio"])("rejects raw diagnostic values at the journal boundary for %s", (field) => {
    expect(() => validatePolicyDiagnostic({ kind: "policy_mismatch", eventKind: "session.created", field, mismatch: "value", expectedType: "string", actualType: "string", actualValue: "sk-private" })).toThrow("UNSAFE_POLICY_DIAGNOSTIC")
  })
  it("never emits arbitrary provider strings, instruction text or unknown object keys", () => {
    const entries = mismatch((session) => {
      session.model = "sk-private-model-token"
      session.instructions = "private instructions with credentials"
      session["private-provider-field"] = { secret: "private-extra" }
      session.tools = [{ type: "function", name: "private-tool-name", description: "private-tool-description" }]
    })
    expect(entries).toContainEqual(expect.objectContaining({ field: "model", actualValue: "REDACTED" }))
    expect(entries).toContainEqual(expect.objectContaining({ field: "instructions", equal: false }))
    expect(entries).toContainEqual(expect.objectContaining({ field: "tools", expectedCount: 0, actualCount: 1 }))
    expect(JSON.stringify(entries)).not.toContain("private")
    expect(entries.length).toBe(3)
  })
  it("records a session identity mismatch as a boolean, never the identifiers", () => {
    const record = vi.fn(); const parser = new ProbeProtocol("diagnostic-run", record)
    parser.accept(JSON.stringify({ type: "session.created", session: { ...probePolicy("diagnostic-run"), id: "private-first" } }))
    expect(() => parser.accept(JSON.stringify({ type: "session.updated", session: { ...probePolicy("diagnostic-run"), id: "private-second" } }))).toThrow("POLICY_MISMATCH")
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ field: "session.id", eventKind: "session.updated", mismatch: "value", equal: false }))
    expect(JSON.stringify(record.mock.calls)).not.toContain("private")
  })
  it("persists sanitized diagnostics but rejects forged paths or secret-shaped enum values", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-diagnostics-"))
    const path = join(dir, "attempt.jsonl"); const journal = new ProbeJournal(path)
    try {
      const entries = mismatch((session) => { session.max_output_tokens = 4096 })
      expect(entries).toHaveLength(1)
      journal.record(entries[0])
      expect(readFileSync(path, "utf8")).toContain("max_output_tokens")
      expect(() => journal.record({ ...entries[0], field: "private-secret-key" })).toThrow("UNSAFE_POLICY_DIAGNOSTIC")
      expect(() => journal.record({ ...entries[0], field: "model", actualValue: "sk-secret" })).toThrow("UNSAFE_POLICY_DIAGNOSTIC")
    } finally { journal.close(); rmSync(dir, { recursive: true }) }
  })
  it("uses one fixed separately authorized v2 claim without changing or deleting v1", () => {
    const controller = readFileSync("scripts/research-voice/probe.ts", "utf8")
    expect(controller).toContain('"compass-research-voice-feasibility-v2.jsonl"')
    expect(controller).not.toMatch(/unlink|rmSync|claimVersion|attemptVersion/)
    const dir = mkdtempSync(join(tmpdir(), "probe-claims-"))
    try {
      const v1 = join(dir, "compass-research-voice-feasibility-v1.jsonl")
      const first = new ProbeJournal(v1); first.close()
      const before = readFileSync(v1, "utf8")
      const second = new ProbeJournal(join(dir, "compass-research-voice-feasibility-v2.jsonl")); second.close()
      expect(readFileSync(v1, "utf8")).toBe(before)
      expect(() => new ProbeJournal(v1)).toThrow()
      expect(() => new ProbeJournal(join(dir, "compass-research-voice-feasibility-v2.jsonl"))).toThrow()
    } finally { rmSync(dir, { recursive: true }) }
  })
})
