import { Sandbox } from "@vercel/sandbox"
import { researchVoiceWorkerCallbackBaseUrl } from "@/lib/compass-url"
import { MAX_RESEARCH_VOICE_LEASE_MS } from "@/lib/research-voice-control-plane"

export const RESEARCH_VOICE_SANDBOX_TIMEOUT_MS = 40 * 60_000

type SandboxCommand = { cmdId: string }
type CreatedSandbox = {
  name: string
  stop(options?: { signal?: AbortSignal }): Promise<{ status: string }>
  runCommand(input: {
    cmd: string
    args: string[]
    env: Record<string, string>
    detached: true
    timeoutMs: number
  }): Promise<SandboxCommand>
}
type CreateSandbox = (input: {
  name: string
  runtime: "node22"
  persistent: false
  timeout: number
  ports: number[]
  networkPolicy: { allow: string[] }
}) => Promise<CreatedSandbox>

const WORKER_BOOTSTRAP = `
const required = ["RESEARCH_VOICE_CALLBACK_BASE_URL", "RESEARCH_VOICE_CALL_ID", "RESEARCH_VOICE_WORKER_TOKEN", "OPENAI_API_KEY", "OPENAI_REALTIME_CALL_ID"];
for (const key of required) if (!process.env[key]) throw new Error(key + " is required");
const headers = { authorization: "Bearer " + process.env.RESEARCH_VOICE_WORKER_TOKEN, "content-type": "application/json" };
const callback = async (path, body) => {
  const response = await fetch(process.env.RESEARCH_VOICE_CALLBACK_BASE_URL + "/" + process.env.RESEARCH_VOICE_CALL_ID + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Compass callback failed with " + response.status);
  return response;
};
const heartbeatLoop = ${runResearchVoiceWorkerHeartbeatLoop.toString()};
const hangup = async () => {
  const response = await fetch("https://api.openai.com/v1/realtime/calls/" + encodeURIComponent(process.env.OPENAI_REALTIME_CALL_ID) + "/hangup", {
    method: "POST", headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY }, signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("OpenAI hangup failed with " + response.status);
};
await heartbeatLoop({ callback: () => callback("/heartbeat", { state: "RUNNING" }), hangup, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
`

export async function runResearchVoiceWorkerHeartbeatLoop({
  callback,
  hangup,
  wait,
  maxFailures = 3,
  intervalMs = 15_000,
}: {
  callback: () => Promise<unknown>
  hangup: () => Promise<unknown>
  wait: (ms: number) => Promise<unknown>
  maxFailures?: number
  intervalMs?: number
}): Promise<never> {
  let failures = 0
  while (true) {
    try {
      await callback()
      failures = 0
      await wait(intervalMs)
    } catch {
      failures += 1
      if (failures >= maxFailures) {
        try { await hangup() } catch { /* process still exits nonzero */ }
        throw new Error("Research voice heartbeat failed")
      }
      await wait(Math.min(1_000 * 2 ** (failures - 1), 5_000))
    }
  }
}

export class ResearchVoiceSandboxLaunchError extends Error {
  constructor(
    message: string,
    readonly sandboxName: string,
    readonly cleanupDefinite: boolean,
  ) {
    super(message)
    this.name = "ResearchVoiceSandboxLaunchError"
  }
}

export async function launchResearchVoiceSandbox({
  createSandbox = (input) => Sandbox.create(input) as unknown as Promise<CreatedSandbox>,
  callId,
  providerCallId,
  workerToken,
  leaseExpiresAt,
  openAIApiKey,
}: {
  createSandbox?: CreateSandbox
  callId: string
  providerCallId: string
  workerToken: string
  leaseExpiresAt: Date
  openAIApiKey: string
}) {
  const callbackBase = researchVoiceWorkerCallbackBaseUrl()
  if (callbackBase.username || callbackBase.password ||
      (process.env.VERCEL_ENV === "production" && (callbackBase.protocol !== "https:" || callbackBase.port))) {
    throw new Error("Research voice callback origin is not trusted")
  }
  const remainingMs = leaseExpiresAt.getTime() - Date.now()
  if (remainingMs <= 0 || remainingMs > MAX_RESEARCH_VOICE_LEASE_MS) throw new Error("Research voice lease is invalid")
  const sandboxName = `compass-research-voice-${callId}`
  let sandbox: CreatedSandbox
  try {
    sandbox = await createSandbox({
      name: sandboxName,
      runtime: "node22",
      persistent: false,
      timeout: RESEARCH_VOICE_SANDBOX_TIMEOUT_MS,
      ports: [],
      networkPolicy: { allow: ["api.openai.com", callbackBase.hostname] },
    })
  } catch {
    throw new ResearchVoiceSandboxLaunchError("Research voice Sandbox creation outcome is unknown", sandboxName, false)
  }
  try {
    const command = await sandbox.runCommand({
      cmd: "node",
      args: ["--input-type=module", "--eval", WORKER_BOOTSTRAP],
      env: {
        RESEARCH_VOICE_CALLBACK_BASE_URL: callbackBase.toString().replace(/\/$/, ""),
        RESEARCH_VOICE_CALL_ID: callId,
        RESEARCH_VOICE_WORKER_TOKEN: workerToken,
        OPENAI_API_KEY: openAIApiKey,
        OPENAI_REALTIME_CALL_ID: providerCallId,
      },
      detached: true,
      timeoutMs: Math.min(remainingMs, MAX_RESEARCH_VOICE_LEASE_MS),
    })
    return { sandboxName, sandboxCommandId: command.cmdId }
  } catch {
    let cleanupDefinite = false
    try {
      const result = await sandbox.stop({ signal: AbortSignal.timeout(10_000) })
      cleanupDefinite = result.status === "stopped"
    } catch {
      // Without a settled command or stop receipt, cleanup retains UNKNOWN.
    }
    throw new ResearchVoiceSandboxLaunchError("Research voice worker startup failed", sandboxName, cleanupDefinite)
  }
}

export async function inspectResearchVoiceSandbox(
  name: string,
  commandId: string,
  dependencies: { getSandbox?: typeof Sandbox.get } = {},
) {
  let sandbox: Awaited<ReturnType<typeof Sandbox.get>>
  try {
    sandbox = await (dependencies.getSandbox ?? Sandbox.get)({ name, resume: false })
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status
    if (status === 404) return { kind: "SANDBOX_ABSENT" as const }
    return { kind: "UNKNOWN" as const, errorCode: "SANDBOX_INSPECTION_FAILED" as const }
  }
  try {
    if (sandbox.status !== "running") return { kind: "PRESENT" as const, sandboxStatus: sandbox.status, command: "NOT_RUNNING" as const }
    const command = await sandbox.currentSession().getCommand(commandId)
    return {
      kind: "PRESENT" as const,
      sandboxStatus: sandbox.status,
      command: command.exitCode === null ? "RUNNING" as const : command.exitCode === 0 ? "COMPLETED" as const : "FAILED" as const,
    }
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status
    if (status === 404) return { kind: "PRESENT" as const, sandboxStatus: sandbox.status, command: "COMMAND_ABSENT" as const }
    return { kind: "UNKNOWN" as const, errorCode: "SANDBOX_INSPECTION_FAILED" as const }
  }
}

export async function stopResearchVoiceSandbox(name: string) {
  const signal = AbortSignal.timeout(10_000)
  let sandbox: Sandbox
  try {
    sandbox = await Sandbox.get({ name, resume: false, signal })
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status
    if (status === 404) return { alreadyStopped: true as const }
    throw error
  }
  if (sandbox.status === "stopped") return { alreadyStopped: true as const }
  // A stop endpoint's 404 does not establish that the named Sandbox is absent.
  const result = await sandbox.stop({ signal })
  if (result.status !== "stopped") throw new Error("Sandbox stop outcome is not confirmed")
  return result
}
