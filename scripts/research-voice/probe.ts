import { chromium } from "@playwright/test"
import { Sandbox } from "@vercel/sandbox"
import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { prepareSyntheticBrowser, releaseSyntheticBrowser } from "./browser"
import { probeBudget } from "./budget"
import { ProbeJournal, singleDispatchFetch } from "./journal"
import { executeProbe, failureCode } from "./lifecycle"
import { createProbeCall } from "./provider"
import { WorkerEvidence } from "./evidence"

export async function runProbe(mode: string, directory: string) {
  if (!["--check", "--live-approved"].includes(mode)) throw new Error("LIVE_APPROVAL_REQUIRED")
  const budget = probeBudget()
  // All fixture generation/build/browser checks precede the durable paid-attempt claim.
  const aiff = join(directory, "synthetic.aiff"); const wavPath = join(directory, "synthetic.wav")
  execFileSync("/usr/bin/say", ["-o", aiff, "Hello Compass. This is a synthetic feasibility test."], { timeout: 10_000, stdio: "ignore" })
  execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wavPath], { timeout: 10_000, stdio: "ignore" })
  const wav = readFileSync(wavPath)
  const worker = readFileSync(join(directory, "worker.cjs"))
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] })
  let journal: ProbeJournal | undefined
  try {
    const page = await browser.newPage() // no tracing, HAR, video, microphone, or console forwarding
    const prepared = await prepareSyntheticBrowser(page, wav)
    if (mode === "--check") return { status: "LOCAL_PREFLIGHT_PASSED", estimatedUsd: budget.estimatedUsd, durationMs: prepared.durationMs }
    const key = process.env.OPENAI_API_KEY
    const cliAuth = JSON.parse(readFileSync(join(homedir(), "Library/Application Support/com.vercel.cli/auth.json"), "utf8")) as { token?: string }
    const token = process.env.VERCEL_TOKEN ?? cliAuth.token
    if (!key || !token) throw new Error("PROBE_CREDENTIALS_UNAVAILABLE")
    const credentials = { token, projectId: "prj_BofzJ65kFnTykvTkoti7o4hjvxw9", teamId: "team_qjKFRvZrF6oR8L9yCtqi8AYU" }
    const runId = randomUUID(); const sandboxName = `compass-voice-probe-${runId}`
    const journalDirectory = join(homedir(), ".geode/probes")
    mkdirSync(journalDirectory, { recursive: true, mode: 0o700 })
    journal = new ProbeJournal(join(journalDirectory, "compass-research-voice-feasibility-v1.jsonl"))
    const record = (entry: Record<string, unknown>) => journal!.record(entry)
    record({ kind: "preflight", runId, estimatedUsd: budget.estimatedUsd, durationMs: prepared.durationMs, bytes: worker.length, sha256: createHash("sha256").update(worker).digest("hex") })
    const started = Date.now(); const deadline = started + 120_000
    const sdkFetch = singleDispatchFetch(fetch)
    let providerCallId: string | null = null; let answer = ""; let sandbox: Sandbox | null = null
    const evidence = new WorkerEvidence()
    let logsSettled = false
    let logTask: Promise<void> | null = null
    const logAbort = new AbortController()
    async function waitFor(predicate: () => boolean, signal: AbortSignal) {
      while (!predicate()) {
        signal.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    return await executeProbe({
      record,
      createProvider: async (signal) => {
        answer = await createProbeCall({ key, offer: prepared.offerSdp, runId, signal, onStatus: (status) => record({ kind: "provider_http", status }), onId: (id) => {
          providerCallId = id; record({ kind: "resource", providerCallId: id })
        } })
      },
      createSandbox: async (signal) => {
        record({ kind: "resource", sandboxName })
        sandbox = await Sandbox.create({ ...credentials, name: sandboxName, persistent: false, runtime: "node22", resources: { vcpus: 1 },
          timeout: Math.max(1, deadline - Date.now()), ports: [], networkPolicy: { allow: ["api.openai.com"] }, fetch: sdkFetch, signal })
        record({ kind: "resource", sandboxName: sandbox.name })
        if (sandbox.name !== sandboxName || sandbox.vcpus !== 1 || JSON.stringify(sandbox.networkPolicy) !== JSON.stringify({ allow: ["api.openai.com"] })) throw new Error("SANDBOX_POLICY_MISMATCH")
      },
      startWorker: async (signal) => {
        const session = sandbox!.currentSession() // never use auto-resuming Sandbox methods
        await session.writeFiles([{ path: "worker.cjs", content: worker }], { signal })
        const command = await session.runCommand({ cmd: "node", args: ["worker.cjs"], detached: true,
          env: { OPENAI_API_KEY: key, PROBE_CALL_ID: providerCallId!, PROBE_RUN_ID: runId, PROBE_DEADLINE_MS: String(deadline - 30_000) }, signal })
        record({ kind: "resource", commandId: command.cmdId })
        logTask = (async () => {
          let buffered = ""; let bytes = 0
          for await (const line of command.logs({ signal: logAbort.signal })) {
            if (line.stream !== "stdout") continue // raw provider/runtime errors never forwarded
            bytes += Buffer.byteLength(line.data)
            if (bytes > 64 * 1024) throw new Error("WORKER_LOG_OVERFLOW")
            buffered += line.data
            let newline: number
            while ((newline = buffered.indexOf("\n")) >= 0) {
              const entry = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>
              buffered = buffered.slice(newline + 1)
              record(entry)
              evidence.accept(entry)
            }
          }
          if (buffered || !evidence.complete()) throw new Error("WORKER_EXITED_WITHOUT_PROOF")
        })().catch((error) => { evidence.fail(error) }).finally(() => { logsSettled = true })
      },
      waitReady: (signal) => waitFor(() => evidence.ready(), signal),
      releaseBrowser: async () => { if (!evidence.ready()) throw new Error("PREMEDIA_NOT_DEMONSTRATED"); await releaseSyntheticBrowser(page, answer); answer = "" },
      waitComplete: (signal) => waitFor(() => evidence.complete() && logsSettled, signal),
      stopProvider: async (signal) => {
        if (!providerCallId) return false
        try {
          const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(providerCallId)}/hangup`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal })
          return response.ok || evidence.providerStopped()
        } catch { return evidence.providerStopped() }
      },
      stopSandbox: async (signal) => {
        // An ambiguous create without an object is unresolved, even on lookup404.
        if (!sandbox) return false
        if (sandbox.status === "stopped") return true
        return (await sandbox.stop({ signal })).status === "stopped"
      },
      closeBrowser: async () => { logAbort.abort(); await logTask; await browser.close() },
    })
  } finally { await browser.close().catch(() => {}); journal?.close() }
}

if (process.argv[1]?.endsWith("probe.cjs")) void runProbe(process.argv[2], process.argv[3]).then((result) => {
  process.stdout.write(JSON.stringify(result) + "\n")
  if ("outcome" in result && (result.outcome !== "PROOF_OBSERVED" || !result.providerStopped || !result.sandboxStopped || !result.browserStopped)) process.exitCode = 1
}).catch((error) => { process.stdout.write(JSON.stringify({ code: failureCode(error) }) + "\n"); process.exitCode = 1 })
