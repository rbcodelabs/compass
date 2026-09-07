import { WebSocket } from "undici"
import { appendFileSync } from "node:fs"
import { ProbeProtocol, probePolicy } from "./protocol"
import { failureCode } from "./lifecycle"

export async function observeProbeSocket(socket: Pick<WebSocket, "addEventListener" | "send" | "close">, protocol: ProbeProtocol, runId: string, deadline: number, record: (entry: Record<string, unknown>) => void): Promise<void> {
  let greeting = false; let ready = false; let settled = false
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(ready ? "PARTICIPANT_NOT_DEMONSTRATED" : "PREMEDIA_NOT_DEMONSTRATED")), Math.max(0, deadline - Date.now()))
    function finish(error?: Error) {
      if (settled) return
      settled = true; clearTimeout(timer)
      try { socket.close() } catch { error ??= new Error("SIDEBAND_CLOSE_FAILED") }
      if (error) reject(error); else resolve()
    }
    socket.addEventListener("open", () => {
      if (settled) return
      try { socket.send(JSON.stringify({ type: "session.update", event_id: `probe_${runId}`, session: probePolicy(runId) })) }
      catch (error) { finish(new Error(failureCode(error))) }
    })
    socket.addEventListener("error", () => finish(new Error("SIDEBAND_TRANSPORT_FAILED")))
    socket.addEventListener("close", () => { if (!settled) finish(new Error("SIDEBAND_CLOSED")) })
    socket.addEventListener("message", ({ data }) => {
      if (settled) return
      try {
        if (typeof data !== "string") throw new Error("INVALID_PROVIDER_FRAME")
        protocol.accept(data)
        if (protocol.policyAcknowledged() && !greeting) { greeting = true; socket.send(JSON.stringify(protocol.requestGreeting())) }
        if (protocol.ready() && !ready) { ready = true; record({ kind: "premedia", status: "ROOT_AND_POLICY_OBSERVED" }) }
        if (protocol.complete()) { record({ kind: "complete", status: "SYNTHETIC_EXCHANGE_OBSERVED" }); finish() }
      } catch (error) { finish(new Error(failureCode(error))) }
    })
  })
}

export async function stopWorkerProvider(callId: string, key: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const result = await fetcher(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
    })
    return result.ok
  } catch { return false }
}

async function main() {
  if (process.argv.includes("--self-test")) {
    new ProbeProtocol("self-test", () => {})
    process.stdout.write("PROBE_WORKER_LOADED\n")
    return
  }
  const { OPENAI_API_KEY: key, PROBE_CALL_ID: callId, PROBE_RUN_ID: runId, PROBE_DEADLINE_MS: rawDeadline } = process.env
  const deadline = Number(rawDeadline)
  if (!key || !callId || !runId || !Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 120_000) throw new Error("INVALID_WORKER_CONFIGURATION")
  const record = (entry: Record<string, unknown>) => {
    const line = JSON.stringify(entry) + "\n"
    // Probe-only redacted recorder; no callback/DB or transcript durability claim.
    appendFileSync("/vercel/sandbox/probe-redacted.jsonl", line, { mode: 0o600, flush: true })
    process.stdout.write(line)
  }
  const protocol = new ProbeProtocol(runId, record)
  const socket = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, { headers: { Authorization: `Bearer ${key}` } })
  try { await observeProbeSocket(socket, protocol, runId, deadline, record) } finally {
    const stopped = await stopWorkerProvider(callId, key)
    record({ kind: "provider_stop", status: stopped ? "STOPPED" : "UNRESOLVED" })
  }
}

if (process.argv[1]?.endsWith("worker.cjs")) void main().catch((error) => { process.stdout.write(JSON.stringify({ kind: "failure", code: failureCode(error) }) + "\n"); process.exitCode = 1 })
