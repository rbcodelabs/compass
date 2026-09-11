import { describe, expect, it, vi } from "vitest"
import { reconcilePersistedResearchVoiceCall } from "@/lib/research-voice-control-plane"
import { terminateResearchVoiceCall } from "@/lib/research-voice-termination"

function fixture() {
  const now = new Date("2026-09-07T12:00:00Z")
  const call: Record<string, unknown> = {
    id: "call-1", sessionId: "session-1", status: "ACTIVE", transcriptIntegrity: "PENDING",
    providerCallId: "provider-1", sandboxName: "sandbox-1", sandboxCommandId: "command-1",
    providerStoppedAt: null, sandboxStoppedAt: null, answerSdp: "private", endedAt: null,
    statusChangedAt: new Date(0), updatedAt: new Date(0), lastHeartbeatAt: new Date(0),
    leaseExpiresAt: new Date(now.getTime() + 60_000), nextProviderOrdinal: 2, lastProviderItemId: "item-1",
  }
  const session = { id: "session-1", voiceLeaseId: "call-1" as string | null }
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => value === undefined ||
      (value instanceof Date ? (row[key] as Date)?.getTime() === value.getTime() : row[key] === value))
  const tx = {
    researchVoiceCall: {
      findUnique: vi.fn(async () => ({ ...call })),
      findFirst: vi.fn(async () => ({ ...call })),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(call, where)) return { count: 0 }
        Object.assign(call, data)
        return { count: 1 }
      }),
    },
    researchSession: { updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!matches(session, where)) return { count: 0 }
      Object.assign(session, data)
      return { count: 1 }
    }) },
  }
  let inTransaction = false
  const prisma = { ...tx, $transaction: vi.fn(async (fn: (transaction: typeof tx) => Promise<unknown>) => {
    const priorCall = { ...call }; const priorSession = { ...session }
    inTransaction = true
    try { return await fn(tx) } catch (error) { Object.assign(call, priorCall); Object.assign(session, priorSession); throw error }
    finally { inTransaction = false }
  }) }
  const cleanup = {
    provider: { hangup: vi.fn(async () => {
      expect(inTransaction).toBe(false)
      expect(call.status).toBe("UNKNOWN")
      expect(call.answerSdp).toBeNull()
      expect(session.voiceLeaseId).toBe("call-1")
      return { definite: true as const }
    }) },
    stopSandbox: vi.fn(async () => { expect(inTransaction).toBe(false) }),
  }
  const run = () => reconcilePersistedResearchVoiceCall({ prisma: prisma as never, voiceCallId: "call-1", sessionId: "session-1", now, cleanup } as Parameters<typeof reconcilePersistedResearchVoiceCall>[0])
  return { now, call, session, tx, prisma, cleanup, run }
}

describe("durable voice cleanup", () => {
  it("publishes intent before I/O and releases only after independent durable receipts", async () => {
    const { call, session, cleanup, run } = fixture()
    cleanup.stopSandbox.mockImplementation(async () => {
      expect(call.providerStoppedAt).toBeInstanceOf(Date)
      expect(session.voiceLeaseId).toBe("call-1")
    })
    await run()
    expect(cleanup.provider.hangup).toHaveBeenCalledWith("provider-1")
    expect(cleanup.stopSandbox).toHaveBeenCalledWith("sandbox-1")
    expect(call).toMatchObject({ status: "FAILED", providerStoppedAt: expect.any(Date), sandboxStoppedAt: expect.any(Date), nextProviderOrdinal: 2 })
    expect(session.voiceLeaseId).toBeNull()
  })

  it("retains UNKNOWN on provider ambiguity while persisting independent Sandbox evidence", async () => {
    const { call, session, cleanup, run } = fixture()
    cleanup.provider.hangup.mockRejectedValue(new Error("404 is not provider stop proof"))
    await run()
    expect(call).toMatchObject({ status: "UNKNOWN", providerStoppedAt: null, sandboxStoppedAt: expect.any(Date) })
    expect(session.voiceLeaseId).toBe("call-1")
    cleanup.provider.hangup.mockResolvedValue({ definite: true })
    await run()
    expect(cleanup.stopSandbox).toHaveBeenCalledOnce()
    expect(session.voiceLeaseId).toBeNull()
  })

  it("retries only Sandbox after its failure, then replays completed cleanup without I/O", async () => {
    const { call, session, cleanup, run } = fixture()
    cleanup.stopSandbox.mockRejectedValueOnce(new Error("Sandbox unavailable"))
    await run()
    expect(call).toMatchObject({ status: "UNKNOWN", providerStoppedAt: expect.any(Date), sandboxStoppedAt: null })
    expect(session.voiceLeaseId).toBe("call-1")
    await run()
    await run()
    expect(cleanup.provider.hangup).toHaveBeenCalledOnce()
    expect(cleanup.stopSandbox).toHaveBeenCalledTimes(2)
    expect(session.voiceLeaseId).toBeNull()
  })

  it("retries immutable resources after crash between external stop and durable receipt", async () => {
    const { call, session, tx, cleanup, run } = fixture()
    const ordinaryWrite = tx.researchVoiceCall.updateMany.getMockImplementation()!
    tx.researchVoiceCall.updateMany.mockImplementation(async (args) => {
      if (args.data.providerStoppedAt) throw new Error("lost receipt")
      return ordinaryWrite(args)
    })
    await expect(run()).rejects.toThrow("lost receipt")
    expect(call.providerStoppedAt).toBeNull()
    expect(session.voiceLeaseId).toBe("call-1")
    expect(cleanup.stopSandbox).not.toHaveBeenCalled()
    tx.researchVoiceCall.updateMany.mockImplementation(ordinaryWrite)
    await run()
    expect(cleanup.provider.hangup).toHaveBeenCalledTimes(2)
    expect(session.voiceLeaseId).toBeNull()
  })

  it("retains the lease for provider creation without known identity", async () => {
    const { call, session, cleanup, run } = fixture()
    Object.assign(call, { status: "UNKNOWN", providerCallId: null })
    await run()
    expect(cleanup.provider.hangup).not.toHaveBeenCalled()
    expect(call.status).toBe("UNKNOWN")
    expect(session.voiceLeaseId).toBe("call-1")
  })

  it("does not infer settled Sandbox creation from missing command or a current absence", async () => {
    const { call, session, run } = fixture()
    Object.assign(call, { status: "UNKNOWN", sandboxCommandId: null })
    await run()
    expect(call.sandboxStoppedAt).toBeNull()
    expect(session.voiceLeaseId).toBe("call-1")
  })

  it("a changed heartbeat defeats stale cleanup intent before destructive I/O", async () => {
    const { call, now, tx, cleanup, run } = fixture()
    const ordinaryWrite = tx.researchVoiceCall.updateMany.getMockImplementation()!
    tx.researchVoiceCall.updateMany.mockImplementationOnce(async (args) => {
      call.lastHeartbeatAt = now
      return ordinaryWrite(args)
    })
    await expect(run()).rejects.toMatchObject({ code: "RECONCILIATION_RACE" })
    expect(cleanup.provider.hangup).not.toHaveBeenCalled()
    expect(cleanup.stopSandbox).not.toHaveBeenCalled()
  })

  it("never clears a newly bound session lease while cleaning the old call", async () => {
    const { session, cleanup, run } = fixture()
    cleanup.provider.hangup.mockImplementation(async () => { session.voiceLeaseId = "new-call"; return { definite: true } })
    await run()
    expect(session.voiceLeaseId).toBe("new-call")
  })

  it("rejects conflicting late resource identity before external I/O", async () => {
    const { prisma, call, cleanup } = fixture()
    call.status = "UNKNOWN"
    await expect(terminateResearchVoiceCall({
      prisma: prisma as never, callId: "call-1", sessionId: "session-1", cleanup,
      creationOutcome: { providerCallId: "different-provider" }, compensation: true,
    })).rejects.toMatchObject({ code: "TERMINATION_RACE" })
    expect(call.providerCallId).toBe("provider-1")
    expect(cleanup.provider.hangup).not.toHaveBeenCalled()
  })

  it("rejects a different call's expected snapshot even within the same session", async () => {
    const { prisma, call, tx, cleanup } = fixture()
    await expect(terminateResearchVoiceCall({
      prisma: prisma as never, callId: "different-call", sessionId: "session-1", cleanup,
      expected: { ...call } as never,
    })).rejects.toMatchObject({ code: "TERMINATION_RACE" })
    expect(tx.researchVoiceCall.updateMany).not.toHaveBeenCalled()
    expect(tx.researchSession.updateMany).not.toHaveBeenCalled()
    expect(cleanup.provider.hangup).not.toHaveBeenCalled()
    expect(cleanup.stopSandbox).not.toHaveBeenCalled()
  })

  it("keeps finalized transcript integrity and order when resources still need cleanup", async () => {
    const { call, cleanup, run } = fixture()
    Object.assign(call, { status: "COMPLETED", transcriptIntegrity: "COMPLETE" })
    cleanup.provider.hangup.mockResolvedValue({ definite: true })
    await run()
    expect(call).toMatchObject({ status: "COMPLETED", transcriptIntegrity: "COMPLETE", nextProviderOrdinal: 2, lastProviderItemId: "item-1" })
  })

  it("preserves the durable expiry reason and failure code on a generic cleanup retry", async () => {
    const { prisma, call, cleanup } = fixture()
    Object.assign(call, { status: "UNKNOWN", endReason: "LEASE_EXPIRED", errorCode: "ORIGINAL_FAILURE" })
    await terminateResearchVoiceCall({ prisma: prisma as never, callId: "call-1", sessionId: "session-1", cleanup })
    expect(call).toMatchObject({ status: "EXPIRED", endReason: "LEASE_EXPIRED", errorCode: "ORIGINAL_FAILURE" })
  })
})
