/**
 * Sandbox reuse across the turns of a conversation (SOL-11): the pure decision
 * (lib/agent-sandbox-reuse.ts) and the acquire flow around the Vercel SDK
 * (lib/agent-sandbox.ts). The platform itself is mocked -- these tests pin down
 * OUR decisions; whether a real sandbox behaves as the SDK documents is verified
 * on the preview via the [agent-turn:timing] log.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const sdk = vi.hoisted(() => {
  class APIError extends Error {
    response: { status: number }
    constructor(status: number) {
      super(`status ${status}`)
      this.response = { status }
    }
  }
  return { APIError, get: vi.fn(), create: vi.fn() }
})
vi.mock("@vercel/sandbox", () => ({
  APIError: sdk.APIError,
  Sandbox: { get: sdk.get, create: sdk.create },
  Snapshot: {},
}))

import {
  AGENT_SANDBOX_IDLE_MS,
  AGENT_SANDBOX_RETENTION_MS,
  PER_TURN_SANDBOX_PATHS,
  agentSandboxReuseEnabled,
  decideSandboxReuse,
  reusedSandboxCleanupScript,
  sandboxNetworkProfile,
} from "@/lib/agent-sandbox-reuse"
import { acquireConversationSandbox, stopSandboxByName } from "@/lib/agent-sandbox"

const NOW = new Date("2026-10-23T12:00:00.000Z")
const NAME = "compass-agent-conv-c-1"
const SNAP = "snap_golden_1"
const PROFILE = "open"
const clean = (over: Record<string, unknown> = {}) => ({
  status: "SUCCEEDED",
  finishedAt: new Date(NOW.getTime() - 60_000),
  sandboxName: NAME,
  ...over,
})
const running = (over: Record<string, unknown> = {}) => ({
  status: "running",
  tags: { snapshotId: SNAP, profile: PROFILE },
  ...over,
})
const decide = (over: Record<string, unknown> = {}) =>
  decideSandboxReuse({
    enabled: true,
    existing: running(),
    profile: PROFILE,
    name: NAME,
    previous: clean(),
    now: NOW,
    ...over,
  } as Parameters<typeof decideSandboxReuse>[0])

describe("agentSandboxReuseEnabled", () => {
  it("is ON by default and only the explicit off values disable it", () => {
    expect(agentSandboxReuseEnabled({})).toBe(true)
    expect(agentSandboxReuseEnabled({ AGENT_SANDBOX_REUSE: "1" })).toBe(true)
    expect(agentSandboxReuseEnabled({ AGENT_SANDBOX_REUSE: "" })).toBe(true)
    for (const off of ["0", "false", "off", " 0 ", "OFF"]) expect(agentSandboxReuseEnabled({ AGENT_SANDBOX_REUSE: off })).toBe(false)
  })
})

describe("sandboxNetworkProfile", () => {
  it("is 'open' without a policy and differs per policy", () => {
    expect(sandboxNetworkProfile(undefined)).toBe("open")
    const a = sandboxNetworkProfile({ allow: ["github.com"] })
    expect(a).toMatch(/^restricted-[0-9a-f]{12}$/)
    expect(sandboxNetworkProfile({ allow: ["github.com"] })).toBe(a)
    expect(sandboxNetworkProfile({ allow: ["github.com", "api.anthropic.com"] })).not.toBe(a)
  })
})

describe("decideSandboxReuse", () => {
  it("is warm when a running sandbox matches the profile and the last run finished cleanly on it", () => {
    expect(decide()).toEqual({ action: "warm", reuse: true, reason: "hit" })
  })
  it("boots only when reuse is off or the conversation has no sandbox yet", () => {
    expect(decide({ enabled: false })).toEqual({ action: "boot", reuse: false, reason: "disabled" })
    expect(decide({ existing: null })).toEqual({ action: "boot", reuse: false, reason: "not-found" })
  })
  it("resumes (never boots over) a sandbox that is not running: its disk is the user's work", () => {
    for (const status of ["stopped", "stopping", "snapshotting", "failed", "aborted", "pending"]) {
      expect(decide({ existing: running({ status }) })).toEqual({ action: "resume", reuse: true, reason: "resumed" })
    }
  })
  it("ignores the golden snapshot: a rebuilt snapshot must not discard a sandbox's clones", () => {
    expect(decide({ existing: running({ tags: { snapshotId: "snap_old", profile: PROFILE } }) }).action).toBe("warm")
  })
  it("resumes on a network-policy profile mismatch so the policy can be re-applied", () => {
    expect(decide({ profile: "restricted-abc" })).toEqual({ action: "resume", reuse: true, reason: "policy-mismatch" })
  })
  it("resumes unless the previous run SUCCEEDED on this very sandbox", () => {
    const expected = { action: "resume", reuse: true, reason: "previous-run-not-clean" }
    for (const status of ["FAILED", "INTERRUPTED", "CANCELED", "RUNNING", "QUEUED"]) {
      expect(decide({ previous: clean({ status }) })).toEqual(expected)
    }
    expect(decide({ previous: null })).toEqual(expected)
    expect(decide({ previous: clean({ finishedAt: null }) })).toEqual(expected)
    expect(decide({ previous: clean({ sandboxName: "compass-agent-run-x" }) })).toEqual(expected)
  })
  it("stays warm however long it has been idle: the sweeper pauses idle sandboxes, one it has not reached is still warm", () => {
    const at = (ms: number) => clean({ finishedAt: new Date(NOW.getTime() - ms) })
    for (const idle of [60_000, AGENT_SANDBOX_IDLE_MS - 1, AGENT_SANDBOX_IDLE_MS + 1, 20 * 60_000]) {
      expect(decide({ previous: at(idle) })).toEqual({ action: "warm", reuse: true, reason: "hit" })
    }
  })
})

describe("reusedSandboxCleanupScript", () => {
  it("wipes the per-turn files (docs tree and manifest included) and never the repo clones", () => {
    const script = reusedSandboxCleanupScript("/vercel/sandbox")
    for (const p of PER_TURN_SANDBOX_PATHS) expect(script).toContain(`/vercel/sandbox/${p}`)
    expect(PER_TURN_SANDBOX_PATHS).toContain("docs")
    expect(PER_TURN_SANDBOX_PATHS).toContain("docs-manifest.json")
    expect(script).not.toContain("repos")
    expect(script).toContain("pkill -KILL -u agentbash")
    expect(script).toContain("[n]ode entry.ts")
  })
})

function fakeSandbox(over: Record<string, unknown> = {}) {
  return {
    name: NAME,
    status: "running",
    tags: { snapshotId: SNAP, profile: PROFILE },
    expiresAt: new Date(Date.now() + 60 * 60_000),
    extendTimeout: vi.fn().mockResolvedValue(undefined),
    updateNetworkPolicy: vi.fn().mockResolvedValue(undefined),
    runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
    stop: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

const acquireOpts = () => ({
  name: NAME,
  snapshotId: SNAP,
  profile: PROFILE,
  previous: clean({ finishedAt: new Date(Date.now() - 60_000) }),
  requiredMs: 22 * 60_000,
  boot: { timeoutMs: 27 * 60_000, tags: { runId: "r-2", workspaceId: "ws-1", snapshotId: SNAP, profile: PROFILE } },
})

describe("acquireConversationSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("uses a warm sandbox as is: no create, no stop, no policy change, per-turn files wiped with sudo", async () => {
    const existing = fakeSandbox()
    sdk.get.mockResolvedValue(existing)
    const result = await acquireConversationSandbox(acquireOpts())
    expect(result).toMatchObject({ reused: true, reason: "hit", sandbox: existing })
    expect(sdk.get).toHaveBeenCalledWith({ name: NAME, resume: false })
    expect(sdk.create).not.toHaveBeenCalled()
    expect(existing.stop).not.toHaveBeenCalled()
    expect(existing.updateNetworkPolicy).not.toHaveBeenCalled()
    const cleanup = existing.runCommand.mock.calls[0][0]
    expect(cleanup).toMatchObject({ cmd: "bash", sudo: true })
    expect(cleanup.args[1]).toContain("/vercel/sandbox/docs")
  })

  it("extends the platform timeout when the remaining time is shorter than the turn needs", async () => {
    const existing = fakeSandbox({ expiresAt: new Date(Date.now() + 2 * 60_000) })
    sdk.get.mockResolvedValue(existing)
    await acquireConversationSandbox(acquireOpts())
    expect(existing.extendTimeout).toHaveBeenCalledTimes(1)
    const extended = existing.extendTimeout.mock.calls[0][0] as number
    expect(extended).toBeGreaterThan(19 * 60_000)
    // Clock time passes between building `expiresAt` and the call, so the gap can exceed 20 min by a few ms.
    expect(extended).toBeLessThanOrEqual(20 * 60_000 + 1000)
  })

  it("does not extend when the sandbox already outlives the turn", async () => {
    const existing = fakeSandbox()
    sdk.get.mockResolvedValue(existing)
    await acquireConversationSandbox(acquireOpts())
    expect(existing.extendTimeout).not.toHaveBeenCalled()
  })

  it("boots a PERSISTENT sandbox under the conversation name when none exists (404), with tags, policy and retention", async () => {
    sdk.get.mockRejectedValue(new sdk.APIError(404))
    const created = fakeSandbox()
    sdk.create.mockResolvedValue(created)
    const policy = { allow: ["github.com"] }
    const opts = acquireOpts()
    const result = await acquireConversationSandbox({ ...opts, previous: null, boot: { ...opts.boot, networkPolicy: policy } })
    expect(result).toMatchObject({ reused: false, reason: "not-found", sandbox: created })
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({
      name: NAME,
      source: { type: "snapshot", snapshotId: SNAP },
      timeout: 27 * 60_000,
      tags: opts.boot.tags,
      networkPolicy: policy,
      persistent: true,
      snapshotExpiration: AGENT_SANDBOX_RETENTION_MS,
      keepLastSnapshots: { count: 1 },
    }))
  })

  it("resumes a stopped sandbox from its persisted disk, re-applying egress before the cleanup and extending its short timeout", async () => {
    const stopped = fakeSandbox({ status: "stopped" })
    const resumed = fakeSandbox({ expiresAt: new Date(Date.now() + 2 * 60_000) })
    sdk.get.mockResolvedValueOnce(stopped).mockResolvedValueOnce(resumed)
    const policy = { allow: ["github.com"] }
    const opts = acquireOpts()
    const result = await acquireConversationSandbox({ ...opts, boot: { ...opts.boot, networkPolicy: policy } })
    expect(result).toMatchObject({ reused: true, reason: "resumed", sandbox: resumed })
    expect(sdk.get).toHaveBeenNthCalledWith(1, { name: NAME, resume: false })
    expect(sdk.get).toHaveBeenNthCalledWith(2, { name: NAME })
    expect(sdk.create).not.toHaveBeenCalled()
    expect(stopped.stop).not.toHaveBeenCalled()
    expect(resumed.updateNetworkPolicy).toHaveBeenCalledWith(policy)
    expect(resumed.updateNetworkPolicy.mock.invocationCallOrder[0]).toBeLessThan(resumed.runCommand.mock.invocationCallOrder[0])
    expect(resumed.extendTimeout).toHaveBeenCalledTimes(1)
  })

  it("resets egress to allow-all on resume when the turn wants no restriction", async () => {
    const resumed = fakeSandbox()
    sdk.get.mockResolvedValueOnce(fakeSandbox({ status: "stopped" })).mockResolvedValueOnce(resumed)
    await acquireConversationSandbox(acquireOpts())
    expect(resumed.updateNetworkPolicy).toHaveBeenCalledWith("allow-all")
  })

  it("pauses (stop, never delete) a running sandbox it cannot trust, then resumes it with its disk", async () => {
    for (const [existingOver, optsOver, reason] of [
      [{ tags: { snapshotId: SNAP, profile: "restricted-old" } }, {}, "policy-mismatch"],
      [{}, { previous: clean({ status: "FAILED" }) }, "previous-run-not-clean"],
    ] as const) {
      vi.clearAllMocks()
      const existing = fakeSandbox(existingOver)
      const resumed = fakeSandbox()
      sdk.get.mockResolvedValueOnce(existing).mockResolvedValueOnce(resumed)
      const result = await acquireConversationSandbox({ ...acquireOpts(), ...optsOver })
      expect(result).toMatchObject({ reused: true, reason, sandbox: resumed })
      expect(existing.stop).toHaveBeenCalled()
      expect(existing.delete).not.toHaveBeenCalled()
      expect(resumed.delete).not.toHaveBeenCalled()
      expect(sdk.create).not.toHaveBeenCalled()
    }
  })

  it("keeps the sandbox when a resume or its preparation fails: the turn fails, nothing is deleted or re-created", async () => {
    const stopped = fakeSandbox({ status: "stopped" })
    const broken = fakeSandbox({ runCommand: vi.fn().mockResolvedValue({ exitCode: 1 }) })
    sdk.get.mockResolvedValueOnce(stopped).mockResolvedValueOnce(broken)
    await expect(acquireConversationSandbox(acquireOpts())).rejects.toThrow("cleanup exited 1")

    vi.clearAllMocks()
    const overMax = fakeSandbox({ expiresAt: new Date(Date.now() + 1000), extendTimeout: vi.fn().mockRejectedValue(new Error("over plan max")) })
    sdk.get.mockResolvedValue(overMax)
    await expect(acquireConversationSandbox(acquireOpts())).rejects.toThrow("over plan max")
    expect(overMax.delete).not.toHaveBeenCalled()
    expect(sdk.create).not.toHaveBeenCalled()
  })

  it("fails the turn rather than creating under the name when the lookup itself failed", async () => {
    sdk.get.mockRejectedValue(new Error("platform 500"))
    await expect(acquireConversationSandbox(acquireOpts())).rejects.toThrow("Could not look up")
    expect(sdk.create).not.toHaveBeenCalled()
  })
})

describe("stopSandboxByName", () => {
  beforeEach(() => vi.clearAllMocks())

  it("pauses without resuming: looks up with resume:false, stops, never deletes", async () => {
    const sandbox = fakeSandbox()
    sdk.get.mockResolvedValue(sandbox)
    await stopSandboxByName(NAME)
    expect(sdk.get).toHaveBeenCalledWith({ name: NAME, resume: false })
    expect(sandbox.stop).toHaveBeenCalled()
    expect(sandbox.delete).not.toHaveBeenCalled()
  })

  it("surfaces an unreachable platform so the caller records the stop as unconfirmed", async () => {
    sdk.get.mockRejectedValue(new Error("platform 500"))
    await expect(stopSandboxByName(NAME)).rejects.toThrow("platform 500")
  })
})
