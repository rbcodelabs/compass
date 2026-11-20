/**
 * The Vercel adapter behind the provider-neutral SandboxHandle. The platform is mocked; these pin the
 * translation Compass relies on, so a second provider can be held to the same contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => {
  class APIError extends Error {
    response: { status: number }
    constructor(status: number) {
      super(`status ${status}`)
      this.response = { status }
    }
  }
  return { APIError, get: vi.fn(), create: vi.fn(), snapshotGet: vi.fn() }
})
vi.mock("@vercel/sandbox", () => ({
  APIError: sdk.APIError,
  Sandbox: { get: sdk.get, create: sdk.create },
  Snapshot: { get: sdk.snapshotGet },
}))

import { isVercelSandboxQuiescent, prepareVercelSandboxStop, toVercelNetworkPolicy, vercelSandboxProvider, wrapVercelSandbox } from "@/lib/sandbox-provider-vercel"

function fakeCommand(over: Record<string, unknown> = {}) {
  return {
    cmdId: "cmd-1",
    exitCode: null as number | null,
    logs: vi.fn(() => (async function* () { yield { stream: "stdout", data: "hi" } })()),
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
    ...over,
  }
}

function fakeSandbox(over: Record<string, unknown> = {}) {
  const session = { getCommand: vi.fn(), snapshot: vi.fn() }
  return {
    name: "sbx",
    status: "running",
    tags: { a: "b" },
    expiresAt: new Date("2026-01-01T00:00:00Z"),
    runCommand: vi.fn(),
    writeFiles: vi.fn().mockResolvedValue(undefined),
    readFileToBuffer: vi.fn(),
    extendTimeout: vi.fn().mockResolvedValue(undefined),
    updateNetworkPolicy: vi.fn().mockResolvedValue("allow-all"),
    stop: vi.fn().mockResolvedValue({ status: "stopped" }),
    delete: vi.fn().mockResolvedValue(undefined),
    currentSession: () => session,
    session,
    ...over,
  }
}

const wrap = (sandbox: ReturnType<typeof fakeSandbox>) => wrapVercelSandbox(sandbox as never)

beforeEach(() => vi.clearAllMocks())

describe("persistent sandbox stop", () => {
  it("dispatches to the prepared session and requires a snapshot from that session", async () => {
    const stop = vi.fn().mockResolvedValue({
      session: { status: "stopped" },
      snapshot: { sourceSessionId: "old-session", status: "created" },
    })
    sdk.get.mockResolvedValueOnce(fakeSandbox({
      currentSession: () => ({ sessionId: "expected-session", status: "running", stop }),
    }))
    const prepared = await prepareVercelSandboxStop("conv")
    expect(prepared?.sessionId).toBe("expected-session")
    expect(stop).not.toHaveBeenCalled()
    await expect(prepared?.stop()).rejects.toThrow("saved snapshot")
    expect(stop).toHaveBeenCalledOnce()
  })

  it("keeps an ambiguous stop fenced when the provider name or target session is missing", async () => {
    sdk.get.mockRejectedValueOnce(new sdk.APIError(404))
    await expect(isVercelSandboxQuiescent("conv", "target")).resolves.toBe(false)
    sdk.get.mockResolvedValueOnce(fakeSandbox({
      currentSnapshotId: "snap",
      currentSession: () => ({ sessionId: "another", status: "stopped" }),
    }))
    await expect(isVercelSandboxQuiescent("conv", "target")).resolves.toBe(false)
    expect(sdk.snapshotGet).not.toHaveBeenCalled()
  })

  it.each([404, 410])("settles a stopped session whose advertised snapshot is gone (%s)", async (status) => {
    const sandbox = fakeSandbox({
      currentSnapshotId: "expired-snapshot",
      currentSession: () => ({ sessionId: "target", status: "stopped" }),
    })
    sdk.get.mockResolvedValue(sandbox)
    sdk.snapshotGet.mockRejectedValueOnce(new sdk.APIError(status))
    await expect(prepareVercelSandboxStop("conv")).resolves.toBeNull()
    sdk.snapshotGet.mockRejectedValueOnce(new sdk.APIError(status))
    await expect(isVercelSandboxQuiescent("conv", "target")).resolves.toBe(true)
    expect(sandbox.stop).not.toHaveBeenCalled()
  })

  it("keeps a stopped session fenced if snapshot lookup fails without proving absence", async () => {
    sdk.get.mockResolvedValueOnce(fakeSandbox({
      currentSnapshotId: "unverified-snapshot",
      currentSession: () => ({ sessionId: "target", status: "stopped" }),
    }))
    sdk.snapshotGet.mockRejectedValueOnce(new sdk.APIError(503))
    await expect(prepareVercelSandboxStop("conv")).rejects.toThrow("503")
  })

  it("requires the current saved snapshot to belong to the stopped target session", async () => {
    const sandbox = fakeSandbox({
      currentSnapshotId: "snap",
      currentSession: () => ({ sessionId: "target", status: "stopped" }),
    })
    sdk.get.mockResolvedValue(sandbox)
    sdk.snapshotGet.mockResolvedValueOnce({ sourceSessionId: "prior", status: "created" })
    await expect(isVercelSandboxQuiescent("conv", "target")).resolves.toBe(false)
    sdk.snapshotGet.mockResolvedValueOnce({ sourceSessionId: "target", status: "created" })
    await expect(isVercelSandboxQuiescent("conv", "target")).resolves.toBe(true)
    expect(sdk.get).toHaveBeenCalledWith({ name: "conv", resume: false })
  })
})

describe("VercelSandboxHandle", () => {
  it("exposes the platform's name, status, tags and expiry", () => {
    const handle = wrap(fakeSandbox())
    expect(handle.name).toBe("sbx")
    expect(handle.status).toBe("running")
    expect(handle.tags).toEqual({ a: "b" })
    expect(handle.expiresAt).toEqual(new Date("2026-01-01T00:00:00Z"))
  })

  it("returns a command handle for a detached run, forwarding every parameter", async () => {
    const sandbox = fakeSandbox()
    const command = fakeCommand()
    sandbox.runCommand.mockResolvedValue(command)
    const signal = new AbortController().signal

    const started = await wrap(sandbox).runCommand({ cmd: "node", args: ["a.ts"], env: { K: "v" }, cwd: "/w", sudo: true, detached: true, timeoutMs: 5, signal })

    expect(sandbox.runCommand).toHaveBeenCalledWith({ cmd: "node", args: ["a.ts"], env: { K: "v" }, cwd: "/w", sudo: true, detached: true, timeoutMs: 5, signal })
    expect(started.cmdId).toBe("cmd-1")
    const lines: unknown[] = []
    for await (const line of started.logs()) lines.push(line)
    expect(lines).toEqual([{ stream: "stdout", data: "hi" }])
    expect(await started.wait()).toEqual({ exitCode: 0 })
  })

  it("reads a command's exit code live, not as of when it started", async () => {
    const sandbox = fakeSandbox()
    const command = fakeCommand()
    sandbox.runCommand.mockResolvedValue(command)
    const started = await wrap(sandbox).runCommand({ cmd: "x", detached: true })
    expect(started.exitCode).toBeNull()
    command.exitCode = 3
    expect(started.exitCode).toBe(3)
  })

  it("returns only the exit code for a plain run", async () => {
    const sandbox = fakeSandbox()
    sandbox.runCommand.mockResolvedValue({ exitCode: 7, extra: "dropped" })
    const result = await wrap(sandbox).runCommand({ cmd: "x" })
    expect(result).toEqual({ exitCode: 7 })
    expect(sandbox.runCommand).toHaveBeenCalledWith({ cmd: "x" })
  })

  it("looks a command up by id, and answers null (not an error) when the platform does not know it", async () => {
    const sandbox = fakeSandbox()
    sandbox.session.getCommand.mockResolvedValueOnce(fakeCommand({ cmdId: "cmd-9", exitCode: 0 }))
    const found = await wrap(sandbox).getCommand("cmd-9")
    expect(found?.cmdId).toBe("cmd-9")
    expect(found?.exitCode).toBe(0)

    sandbox.session.getCommand.mockRejectedValueOnce(new sdk.APIError(404))
    expect(await wrap(sandbox).getCommand("nope")).toBeNull()

    sandbox.session.getCommand.mockRejectedValueOnce(new sdk.APIError(500))
    await expect(wrap(sandbox).getCommand("boom")).rejects.toThrow()
  })

  it("converts string file content to bytes and forwards the abort signal", async () => {
    const sandbox = fakeSandbox()
    const signal = new AbortController().signal
    await wrap(sandbox).writeFiles([{ path: "a.txt", content: "héllo" }, { path: "b.bin", content: new Uint8Array([1, 2]) }], { signal })
    const [files, opts] = sandbox.writeFiles.mock.calls[0]
    expect(files[0]).toEqual({ path: "a.txt", content: Buffer.from("héllo") })
    expect(Buffer.isBuffer(files[1].content)).toBe(true)
    expect([...files[1].content]).toEqual([1, 2])
    expect(opts).toEqual({ signal })
  })

  it("passes reads, timeouts, policy, stop and delete straight through", async () => {
    const sandbox = fakeSandbox()
    sandbox.readFileToBuffer.mockResolvedValue(Buffer.from("x"))
    const handle = wrap(sandbox)
    expect(await handle.readFileToBuffer({ path: "/f" })).toEqual(Buffer.from("x"))
    await handle.extendTimeout(5_000)
    expect(sandbox.extendTimeout).toHaveBeenCalledWith(5_000)
    await handle.updateNetworkPolicy({ allow: ["github.com"] })
    expect(sandbox.updateNetworkPolicy).toHaveBeenCalledWith({ allow: ["github.com"] })
    const signal = new AbortController().signal
    await expect(handle.stop({ signal })).resolves.toBeUndefined()
    expect(sandbox.stop).toHaveBeenCalledWith({ signal })
    await expect(handle.delete()).resolves.toBeUndefined()
  })

  it("snapshots to a provider-neutral image id", async () => {
    const sandbox = fakeSandbox()
    sandbox.session.snapshot.mockResolvedValue({ snapshotId: "snap_1", sizeBytes: 42 })
    expect(await wrap(sandbox).snapshot()).toEqual({ imageId: "snap_1", sizeBytes: 42 })
  })
})

describe("vercelSandboxProvider", () => {
  it("boots from a snapshot with only the options it was given", async () => {
    sdk.create.mockResolvedValue(fakeSandbox())
    await vercelSandboxProvider.boot({ snapshotId: "snap_1", timeoutMs: 1000 })
    expect(sdk.create).toHaveBeenCalledWith({ source: { type: "snapshot", snapshotId: "snap_1" }, timeout: 1000 })

    const signal = new AbortController().signal
    await vercelSandboxProvider.boot({
      snapshotId: "snap_1", timeoutMs: 1000, name: "n", tags: { t: "1" }, persistent: true, snapshotExpirationMs: 9, networkPolicy: { allow: ["h"] }, signal,
    })
    expect(sdk.create).toHaveBeenLastCalledWith({
      source: { type: "snapshot", snapshotId: "snap_1" }, timeout: 1000, networkPolicy: { allow: ["h"] }, name: "n", tags: { t: "1" },
      persistent: true, snapshotExpiration: 9, keepLastSnapshots: { count: 1 }, signal,
    })
  })

  it("looks up by name, resuming unless told not to, and stops by name without resuming", async () => {
    const sandbox = fakeSandbox()
    sdk.get.mockResolvedValue(sandbox)
    await vercelSandboxProvider.getByName("n")
    expect(sdk.get).toHaveBeenLastCalledWith({ name: "n" })
    await vercelSandboxProvider.getByName("n", { resume: false })
    expect(sdk.get).toHaveBeenLastCalledWith({ name: "n", resume: false })
    await vercelSandboxProvider.stopByName("n")
    expect(sdk.get).toHaveBeenLastCalledWith({ name: "n", resume: false })
    expect(sandbox.stop).toHaveBeenCalledTimes(1)
  })

  it("deletes an image and classifies the two errors callers branch on", async () => {
    const snapshot = { delete: vi.fn().mockResolvedValue(undefined) }
    sdk.snapshotGet.mockResolvedValue(snapshot)
    await vercelSandboxProvider.deleteImage("snap_1")
    expect(sdk.snapshotGet).toHaveBeenCalledWith({ snapshotId: "snap_1" })
    expect(snapshot.delete).toHaveBeenCalled()

    expect(vercelSandboxProvider.isNotFound(new sdk.APIError(404))).toBe(true)
    expect(vercelSandboxProvider.isNotFound(new sdk.APIError(410))).toBe(false)
    expect(vercelSandboxProvider.isSnapshotGone(new sdk.APIError(410))).toBe(true)
    expect(vercelSandboxProvider.isSnapshotGone(new Error("410"))).toBe(false)
  })
})

describe("toVercelNetworkPolicy", () => {
  it("passes the string policies through and maps denySubnets to subnets.deny", () => {
    expect(toVercelNetworkPolicy("deny-all")).toBe("deny-all")
    expect(toVercelNetworkPolicy({ allow: ["h"] })).toEqual({ allow: ["h"] })
    expect(toVercelNetworkPolicy({ allow: ["h"], denySubnets: ["10.0.0.0/8"] })).toEqual({ allow: ["h"], subnets: { deny: ["10.0.0.0/8"] } })
  })
})
