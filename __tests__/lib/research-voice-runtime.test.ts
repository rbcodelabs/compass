import { afterEach, describe, expect, it, vi } from "vitest"
import { spawnSync } from "node:child_process"
import {
  OpenAIRealtimeProviderError,
  createOpenAIRealtimeProvider,
} from "@/lib/research-voice-provider"
import {
  RESEARCH_VOICE_SANDBOX_TIMEOUT_MS,
  inspectResearchVoiceSandbox,
  launchResearchVoiceSandbox,
  runResearchVoiceWorkerHeartbeatLoop,
} from "@/lib/research-voice-sandbox"
import { provisionAllocatedResearchVoiceCall } from "@/lib/research-voice-provisioning"

afterEach(() => vi.unstubAllEnvs())

describe("authoritative research voice runtime", () => {
  const audioSdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"

  function provisioningFixture() {
    const call: Record<string, unknown> = {
      id: "call-1", sessionId: "session-1", status: "PROVISIONING", providerCallId: null,
      sandboxName: null, sandboxCommandId: null, statusChangedAt: new Date(0), answerSdp: null,
    }
    const tx = {
      researchVoiceCall: {
        findUnique: vi.fn(async () => ({ ...call })),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(call, data); return { count: 1 } }),
      },
      researchSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = { ...tx, $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) }
    const provider = { createCall: vi.fn().mockResolvedValue({ answerSdp: audioSdp, providerCallId: "provider-1" }), hangup: vi.fn().mockResolvedValue({ definite: true }) }
    const launcher = vi.fn().mockResolvedValue({ sandboxName: "compass-research-voice-call-1", sandboxCommandId: "cmd-1" })
    const stopSandbox = vi.fn().mockResolvedValue(undefined)
    const input = { prisma: prisma as never, provider, launcher, stopSandbox, model: "gpt-realtime", offerSdp: audioSdp,
      allocation: { replayed: false, workerToken: "raw", call: { id: "call-1", sessionId: "session-1", status: "PROVISIONING", answerSdp: null, leaseExpiresAt: new Date(Date.now() + 60_000) } },
    }
    return { call, tx, provider, launcher, stopSandbox, input }
  }

  it("persists provider provenance and cleanup evidence when response failure hangup is ambiguous", async () => {
    const { call, provider, input } = provisioningFixture()
    provider.createCall.mockRejectedValue(new OpenAIRealtimeProviderError("bad body", "PROVIDER_RESPONSE_AMBIGUOUS", true, undefined, "provider-1"))
    provider.hangup.mockRejectedValue(new Error("network"))
    await expect(provisionAllocatedResearchVoiceCall(input)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_AMBIGUOUS" })
    expect(call).toMatchObject({ status: "UNKNOWN", providerCallId: "provider-1", sandboxName: "compass-research-voice-call-1", sandboxStoppedAt: expect.any(Date) })
    expect(call.providerStoppedAt).toBeNull()
  })

  it.each(["provider", "worker"])("compensates a failed %s state write after establishing durable ownership", async (stage) => {
    const { call, tx, provider, input } = provisioningFixture()
    const ordinaryWrite = tx.researchVoiceCall.updateMany.getMockImplementation()!
    tx.researchVoiceCall.updateMany.mockImplementationOnce(stage === "provider" ? async () => { throw new Error("database") } : ordinaryWrite)
    if (stage === "worker") tx.researchVoiceCall.updateMany.mockImplementationOnce(async () => { throw new Error("database") })
    await expect(provisionAllocatedResearchVoiceCall(input)).rejects.toThrow("database")
    expect(provider.hangup).toHaveBeenCalledOnce()
    expect(call).toMatchObject({ status: "FAILED", providerCallId: "provider-1", providerStoppedAt: expect.any(Date), sandboxStoppedAt: expect.any(Date) })
  })

  it("preserves a worker whose successful state write returned an ambiguous error", async () => {
    const { call, tx, provider, stopSandbox, input } = provisioningFixture()
    const ordinaryWrite = tx.researchVoiceCall.updateMany.getMockImplementation()!
    tx.researchVoiceCall.updateMany.mockImplementationOnce(ordinaryWrite).mockImplementationOnce(async ({ data }) => {
      Object.assign(call, data)
      throw new Error("connection lost after commit")
    })
    await expect(provisionAllocatedResearchVoiceCall(input)).resolves.toMatchObject({ status: "WORKER_STARTING" })
    expect(provider.hangup).not.toHaveBeenCalled()
    expect(stopSandbox).not.toHaveBeenCalled()
  })

  it("preserves the lease and resources when compensation cannot read ownership", async () => {
    const { tx, provider, stopSandbox, input } = provisioningFixture()
    tx.researchVoiceCall.updateMany.mockRejectedValueOnce(new Error("database"))
    tx.researchVoiceCall.findUnique.mockRejectedValue(new Error("database unavailable"))
    await expect(provisionAllocatedResearchVoiceCall(input)).rejects.toThrow()
    expect(provider.hangup).not.toHaveBeenCalled()
    expect(stopSandbox).not.toHaveBeenCalled()
    expect(tx.researchSession.updateMany).not.toHaveBeenCalled()
  })

  it("creates a Realtime call once and trusts only the OpenAI Location header", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(audioSdp, {
      status: 201,
      headers: { location: "https://api.openai.com/v1/realtime/calls/call_123" },
    }))
    const provider = createOpenAIRealtimeProvider({ apiKey: "server-key", fetcher })

    await expect(provider.createCall({ offerSdp: audioSdp, model: "gpt-realtime" }))
      .resolves.toEqual({ answerSdp: audioSdp, providerCallId: "call_123" })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls", expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer server-key" },
    }))

    fetcher.mockResolvedValueOnce(new Response(audioSdp, {
      status: 201,
      headers: { location: "https://attacker.example/v1/realtime/calls/call_123" },
    }))
    await expect(provider.createCall({ offerSdp: audioSdp, model: "gpt-realtime" }))
      .rejects.toMatchObject({ code: "UNTRUSTED_PROVIDER_LOCATION", ambiguous: true })
  })

  it.each([
    ["application data channel", "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"],
    ["video", "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"],
    ["multiple audio sections", "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"],
  ])("rejects a non-audio-only %s offer before provider I/O", async (_name, offerSdp) => {
    const fetcher = vi.fn()
    const provider = createOpenAIRealtimeProvider({ apiKey: "server-key", fetcher })
    await expect(provider.createCall({ offerSdp, model: "gpt-realtime" }))
      .rejects.toMatchObject({ code: "INVALID_AUDIO_SDP", ambiguous: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("rejects a provider answer that is not strictly audio-only as ambiguous", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
      { status: 201, headers: { location: "https://api.openai.com/v1/realtime/calls/call_123" } },
    ))
    const provider = createOpenAIRealtimeProvider({ apiKey: "server-key", fetcher })
    await expect(provider.createCall({ offerSdp: audioSdp, model: "gpt-realtime" }))
      .rejects.toMatchObject({ code: "INVALID_PROVIDER_AUDIO_SDP", ambiguous: true })
  })

  it("classifies a transport failure as ambiguous and never retries it", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("socket reset"))
    const provider = createOpenAIRealtimeProvider({ apiKey: "server-key", fetcher })
    await expect(provider.createCall({ offerSdp: audioSdp, model: "gpt-realtime" }))
      .rejects.toBeInstanceOf(OpenAIRealtimeProviderError)
    await expect(provider.createCall({ offerSdp: audioSdp, model: "gpt-realtime" }))
      .rejects.toMatchObject({ code: "PROVIDER_CREATE_AMBIGUOUS", ambiguous: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("classifies provider server failures as ambiguous without retrying", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    await expect(createOpenAIRealtimeProvider({ apiKey: "key", fetcher }).createCall({ offerSdp: audioSdp, model: "gpt-realtime" }))
      .rejects.toMatchObject({ code: "PROVIDER_CREATE_AMBIGUOUS", ambiguous: true, status: 503 })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("puts a bounded AbortSignal on provider allocation and hangup", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(audioSdp, { status: 201, headers: { location: "/v1/realtime/calls/call_1" } })).mockResolvedValueOnce(new Response(null, { status: 200 }))
    const provider = createOpenAIRealtimeProvider({ apiKey: "key", fetcher })
    await provider.createCall({ offerSdp: audioSdp, model: "gpt-realtime" }); await provider.hangup("call_1")
    for (const [, options] of fetcher.mock.calls) expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it("stops a possibly-created Sandbox when detached worker startup fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000")
    const stop = vi.fn().mockResolvedValue({ status: "stopped" })
    const create = vi.fn().mockResolvedValue({
      name: "voice-call-1", stop,
      runCommand: vi.fn().mockRejectedValue(new Error("command failed")),
    })
    await expect(launchResearchVoiceSandbox({
      createSandbox: create, callId: "call-1", providerCallId: "provider-1",
      workerToken: "token", leaseExpiresAt: new Date(Date.now() + 60_000), openAIApiKey: "key",
    })).rejects.toMatchObject({
      name: "ResearchVoiceSandboxLaunchError", sandboxName: "compass-research-voice-call-1", cleanupDefinite: true,
    })
    expect(stop).toHaveBeenCalledOnce()
  })

  it("distinguishes Sandbox and command absence from ambiguous inspection failure", async () => {
    await expect(inspectResearchVoiceSandbox("voice-1", "cmd-1", {
      getSandbox: vi.fn().mockRejectedValue({ response: { status: 404 } }),
    })).resolves.toEqual({ kind: "SANDBOX_ABSENT" })
    await expect(inspectResearchVoiceSandbox("voice-1", "cmd-1", {
      getSandbox: vi.fn().mockRejectedValue(new TypeError("network")),
    })).resolves.toEqual({ kind: "UNKNOWN", errorCode: "SANDBOX_INSPECTION_FAILED" })
    await expect(inspectResearchVoiceSandbox("voice-1", "cmd-1", {
      getSandbox: vi.fn().mockResolvedValue({
        status: "running", currentSession: () => ({ getCommand: vi.fn().mockResolvedValue({ exitCode: null }) }),
      }),
    })).resolves.toEqual({ kind: "PRESENT", sandboxStatus: "running", command: "RUNNING" })
    await expect(inspectResearchVoiceSandbox("voice-1", "cmd-1", {
      getSandbox: vi.fn().mockResolvedValue({
        status: "running", currentSession: () => ({ getCommand: vi.fn().mockRejectedValue({ response: { status: 404 } }) }),
      }),
    })).resolves.toEqual({ kind: "PRESENT", sandboxStatus: "running", command: "COMMAND_ABSENT" })
  })

  it("runs sequential heartbeats and hangs up before exiting after bounded callback failures", async () => {
    let active = 0
    let maxActive = 0
    const callback = vi.fn()
      .mockImplementationOnce(async () => { active += 1; maxActive = Math.max(maxActive, active); active -= 1 })
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockRejectedValueOnce(new TypeError("network"))
    const hangup = vi.fn().mockResolvedValue(undefined)
    await expect(runResearchVoiceWorkerHeartbeatLoop({
      callback, hangup, wait: vi.fn().mockResolvedValue(undefined), maxFailures: 2,
    })).rejects.toThrow("heartbeat")
    expect(maxActive).toBe(1)
    expect(callback).toHaveBeenCalledTimes(3)
    expect(hangup).toHaveBeenCalledOnce()
  })

  it.each([0, 1])("executes the emitted worker in Node and hangs up after callback failures following %i successes", async (successes) => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://compass.example")
    const runCommand = vi.fn().mockResolvedValue({ cmdId: "cmd-1" })
    await launchResearchVoiceSandbox({
      createSandbox: vi.fn().mockResolvedValue({ name: "voice-1", runCommand, stop: vi.fn() }),
      callId: "call-1", providerCallId: "provider-1", workerToken: "worker-token",
      leaseExpiresAt: new Date(Date.now() + 60_000), openAIApiKey: "mock-key",
    })
    const command = runCommand.mock.calls[0][0]
    const mocks = `
      let callbacks = 0;
      globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 1; };
      globalThis.fetch = async (url, options) => {
        if (!(options.signal instanceof AbortSignal)) throw new Error("FETCH_TIMEOUT_MISSING");
        if (url.endsWith("/hangup")) { process.stdout.write("HANGUP"); return { ok: true }; }
        callbacks += 1;
        if (callbacks <= ${successes}) return { ok: true };
        if (callbacks % 2) return { ok: false, status: 401 };
        throw new TypeError("network failure");
      };
    `
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", mocks + command.args[2]], {
      env: { ...process.env, ...command.env }, encoding: "utf8", timeout: 5_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("HANGUP")
    expect(result.stderr).toContain("Research voice heartbeat failed")
  })

  it("does not resume a stopped Sandbox or use the auto-resuming Sandbox command accessor", async () => {
    const getCommand = vi.fn()
    const resume = vi.fn()
    const currentSession = vi.fn().mockReturnValue({ getCommand: vi.fn().mockRejectedValue(new Error("stopping")) })
    const getSandbox = vi.fn().mockResolvedValue({ status: "stopped", getCommand, resume, currentSession })
    await expect(inspectResearchVoiceSandbox("voice-1", "cmd-1", { getSandbox })).resolves.toMatchObject({ kind: "PRESENT", sandboxStatus: "stopped" })
    expect(currentSession).not.toHaveBeenCalled()
    getSandbox.mockResolvedValue({ status: "running", getCommand, resume, currentSession })
    await expect(inspectResearchVoiceSandbox("voice-1", "cmd-1", { getSandbox })).resolves.toMatchObject({ kind: "UNKNOWN" })
    expect(getCommand).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it("launches a named nonpersistent sandbox with only OpenAI and the trusted callback host", async () => {
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://compass.example")
    const runCommand = vi.fn().mockResolvedValue({ cmdId: "cmd_123" })
    const create = vi.fn().mockResolvedValue({ name: "voice-call-1", runCommand, stop: vi.fn() })

    await expect(launchResearchVoiceSandbox({
      createSandbox: create,
      callId: "00000000-0000-4000-8000-000000000001",
      providerCallId: "call_123",
      workerToken: "raw-worker-token",
      leaseExpiresAt: new Date(Date.now() + 35 * 60_000),
      openAIApiKey: "server-key",
    })).resolves.toEqual({ sandboxName: "compass-research-voice-00000000-0000-4000-8000-000000000001", sandboxCommandId: "cmd_123" })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "compass-research-voice-00000000-0000-4000-8000-000000000001",
      persistent: false,
      timeout: RESEARCH_VOICE_SANDBOX_TIMEOUT_MS,
      ports: [],
      networkPolicy: { allow: ["api.openai.com", "compass.example"] },
    }))
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
      detached: true,
      env: expect.objectContaining({
        RESEARCH_VOICE_CALLBACK_BASE_URL: "https://compass.example/api/internal/research/voice",
        RESEARCH_VOICE_WORKER_TOKEN: "raw-worker-token",
        OPENAI_API_KEY: "server-key",
      }),
    }))
  })

  it("rejects callback origins with credentials or non-default production ports", async () => {
    vi.stubEnv("VERCEL_ENV", "production")
    for (const baseUrl of ["https://user:pass@compass.example", "https://compass.example:8443"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", baseUrl)
      await expect(launchResearchVoiceSandbox({
        createSandbox: vi.fn(), callId: "call-1", providerCallId: "provider-1",
        workerToken: "token", leaseExpiresAt: new Date(Date.now() + 60_000), openAIApiKey: "key",
      })).rejects.toThrow()
    }
  })

  it("marks an ambiguous provider allocation UNKNOWN and releases only the matching lease", async () => {
    const tx = {
      researchVoiceCall: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      researchSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = { ...tx, $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) }
    const provider = {
      createCall: vi.fn().mockRejectedValue(new OpenAIRealtimeProviderError(
        "unknown", "PROVIDER_CREATE_AMBIGUOUS", true,
      )),
      hangup: vi.fn(),
    }
    await expect(provisionAllocatedResearchVoiceCall({
      prisma: prisma as never,
      allocation: {
        replayed: false,
        workerToken: "raw-once",
        call: {
          id: "call-1", sessionId: "session-1", status: "PROVISIONING",
          leaseExpiresAt: new Date(Date.now() + 60_000), answerSdp: null,
        },
      },
      provider,
      launcher: vi.fn(),
      model: "gpt-realtime",
      offerSdp: "offer",
    })).rejects.toMatchObject({ code: "PROVIDER_CREATE_AMBIGUOUS" })
    expect(provider.createCall).toHaveBeenCalledTimes(1)
    expect(tx.researchVoiceCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "call-1", sessionId: "session-1" }),
      data: expect.objectContaining({ status: "UNKNOWN", transcriptIntegrity: "DEGRADED" }),
    }))
    expect(tx.researchSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "session-1", voiceLeaseId: "call-1" },
      data: expect.objectContaining({ voiceLeaseId: null, voiceLeaseExpiresAt: null }),
    }))
  })

  it.each([
    ["definite cleanup", true, "FAILED"],
    ["ambiguous Sandbox cleanup", false, "UNKNOWN"],
  ])("compensates a post-provider failure with %s", async (_name, cleanupDefinite, expectedStatus) => {
    const tx = {
      researchVoiceCall: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          id: "call-1", sessionId: "session-1", status: "PROVIDER_CREATED", providerCallId: "provider-1",
          sandboxName: null, sandboxCommandId: null, statusChangedAt: new Date(0),
        }),
      },
      researchSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = { ...tx, $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) }
    const provider = {
      createCall: vi.fn().mockResolvedValue({ answerSdp: audioSdp, providerCallId: "provider-1" }),
      hangup: vi.fn().mockResolvedValue({ definite: true }),
    }
    await expect(provisionAllocatedResearchVoiceCall({
      prisma: prisma as never,
      allocation: { replayed: false, workerToken: "raw", call: {
        id: "call-1", sessionId: "session-1", status: "PROVISIONING",
        leaseExpiresAt: new Date(Date.now() + 60_000), answerSdp: null,
      } },
      provider,
      launcher: vi.fn().mockRejectedValue(Object.assign(new Error("launch failed"), {
        name: "ResearchVoiceSandboxLaunchError",
        sandboxName: "compass-research-voice-call-1",
        cleanupDefinite,
      })),
      stopSandbox: cleanupDefinite ? vi.fn() : vi.fn().mockRejectedValue(new Error("unknown stop")),
      model: "gpt-realtime", offerSdp: audioSdp,
    })).rejects.toThrow()
    expect(provider.hangup).toHaveBeenCalledWith("provider-1")
    expect(tx.researchVoiceCall.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: expectedStatus, transcriptIntegrity: "DEGRADED" }),
    }))
  })

  it("returns a non-destructive in-progress receipt after crashing before the one-time worker credential was consumed", async () => {
    const tx = {
      researchVoiceCall: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      researchSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = { ...tx, $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) }
    const provider = { createCall: vi.fn(), hangup: vi.fn().mockResolvedValue({ definite: true }) }
    await expect(provisionAllocatedResearchVoiceCall({
      prisma: prisma as never,
      allocation: { replayed: true, workerToken: null, call: {
        id: "call-1", sessionId: "session-1", status: "PROVIDER_CREATED",
        providerCallId: "provider-1", answerSdp: audioSdp, leaseExpiresAt: new Date(Date.now() + 60_000),
      } },
      provider, launcher: vi.fn(), stopSandbox: vi.fn().mockResolvedValue(undefined),
      model: "gpt-realtime", offerSdp: audioSdp,
    })).resolves.toEqual({ callId: "call-1", answerSdp: null, status: "PROVISIONING_IN_PROGRESS", replayed: true })
    expect(provider.createCall).not.toHaveBeenCalled()
    expect(provider.hangup).not.toHaveBeenCalled()
    expect(tx.researchVoiceCall.updateMany).not.toHaveBeenCalled()
  })

  it("compensates a known provider call when reading its 201 response body fails", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 201,
      headers: new Headers({ location: "https://api.openai.com/v1/realtime/calls/provider-1" }),
      text: vi.fn().mockRejectedValue(new TypeError("body truncated")),
    })
    const provider = createOpenAIRealtimeProvider({ apiKey: "server-key", fetcher: fetcher as never })
    await expect(provider.createCall({ offerSdp: audioSdp, model: "gpt-realtime" }))
      .rejects.toMatchObject({ code: "PROVIDER_RESPONSE_AMBIGUOUS", providerCallId: "provider-1" })
  })
})
