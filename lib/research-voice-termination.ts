import type { PrismaClient, ResearchVoiceCall } from "@prisma/client"
import { ResearchVoiceControlPlaneError } from "@/lib/research-voice-control-plane"

type TerminationPrisma = Pick<PrismaClient, "$transaction" | "researchVoiceCall">
export type ResearchVoiceCleanup = {
  provider: { hangup(providerCallId: string): Promise<{ definite: true }> }
  stopSandbox(name: string): Promise<unknown>
}

// These are internal, trusted creation outcomes, never callback/request fields.
export type ResearchVoiceCreationOutcome = {
  providerCallId?: string
  sandboxName?: string
  sandboxCommandId?: string
  providerNeverCreated?: boolean
  sandboxNeverCreated?: boolean
  sandboxStopped?: boolean
}

export function voiceCleanupFence(call: ResearchVoiceCall) {
  return {
    id: call.id, sessionId: call.sessionId, status: call.status,
    statusChangedAt: call.statusChangedAt, updatedAt: call.updatedAt,
    providerCallId: call.providerCallId, sandboxName: call.sandboxName,
    sandboxCommandId: call.sandboxCommandId,
    providerStoppedAt: call.providerStoppedAt, sandboxStoppedAt: call.sandboxStoppedAt,
    lastHeartbeatAt: call.lastHeartbeatAt, leaseExpiresAt: call.leaseExpiresAt,
    transcriptIntegrity: call.transcriptIntegrity,
    nextProviderOrdinal: call.nextProviderOrdinal, lastProviderItemId: call.lastProviderItemId,
  }
}

function nextVersion(call: ResearchVoiceCall, now: Date) {
  return new Date(Math.max(now.getTime(), call.statusChangedAt.getTime() + 1, call.updatedAt.getTime() + 1))
}

function race(code: string): never {
  throw new ResearchVoiceControlPlaneError("Voice cleanup ownership changed concurrently", 409, code)
}

/** One bounded cleanup pass. UNKNOWN denies workers but remains retryable here. */
export async function terminateResearchVoiceCall({
  prisma, callId, sessionId, cleanup, expected, creationOutcome = {},
  errorCode, endReason, now = new Date(),
  compensation = false, raceCode = "TERMINATION_RACE",
}: {
  prisma: TerminationPrisma
  callId: string
  sessionId: string
  cleanup?: ResearchVoiceCleanup
  expected?: ResearchVoiceCall
  creationOutcome?: ResearchVoiceCreationOutcome
  errorCode?: string
  endReason?: string
  now?: Date
  compensation?: boolean
  raceCode?: string
}) {
  let call = await prisma.$transaction(async (tx) => {
    const observed = expected ?? await tx.researchVoiceCall.findUnique({ where: { id: callId } })
    if (!observed || observed.id !== callId || observed.sessionId !== sessionId) race(raceCode)
    // A late creation result may attach to a stopped/unknown attempt, but must
    // never seize an advanced, running provisioning owner.
    if (compensation && !["PROVISIONING", "PROVIDER_CREATED", "DISCONNECTING", "FAILED", "EXPIRED", "UNKNOWN"].includes(observed.status)) race(raceCode)
    const outcome = creationOutcome
    if ((outcome.providerCallId && observed.providerCallId && outcome.providerCallId !== observed.providerCallId) ||
        (outcome.sandboxName && observed.sandboxName && outcome.sandboxName !== observed.sandboxName) ||
        (outcome.sandboxCommandId && observed.sandboxCommandId && outcome.sandboxCommandId !== observed.sandboxCommandId) ||
        (outcome.providerNeverCreated && (observed.providerCallId || outcome.providerCallId)) ||
        (outcome.sandboxNeverCreated && (observed.sandboxCommandId || outcome.sandboxCommandId))) race(raceCode)
    const version = nextVersion(observed, now)
    const data = {
      status: observed.status === "COMPLETED" ? "COMPLETED" : "UNKNOWN",
      transcriptIntegrity: observed.transcriptIntegrity === "COMPLETE" ? "COMPLETE" : "DEGRADED",
      answerSdp: null, endedAt: observed.endedAt ?? now,
      errorCode: errorCode ?? observed.errorCode ?? "VOICE_CLEANUP_REQUIRED",
      endReason: observed.endReason ?? endReason ?? (observed.status === "EXPIRED" ? "LEASE_EXPIRED" : null),
      providerCallId: outcome.providerCallId ?? observed.providerCallId,
      sandboxName: outcome.sandboxName ?? observed.sandboxName,
      sandboxCommandId: outcome.sandboxCommandId ?? observed.sandboxCommandId,
      // Newly discovered resources cannot inherit a prior absence receipt.
      providerStoppedAt: outcome.providerCallId && !observed.providerCallId ? null :
        observed.providerStoppedAt ?? (outcome.providerNeverCreated ? now : null),
      sandboxStoppedAt: outcome.sandboxStopped || outcome.sandboxNeverCreated ? (observed.sandboxStoppedAt ?? now) :
        (outcome.sandboxName && !observed.sandboxName) || (outcome.sandboxCommandId && !observed.sandboxCommandId) ? null : observed.sandboxStoppedAt,
      statusChangedAt: version, updatedAt: version,
    }
    const result = await tx.researchVoiceCall.updateMany({ where: voiceCleanupFence(observed), data })
    if (result.count !== 1) race(raceCode)
    return { ...observed, ...data }
  })

  async function recordStop(resource: "providerStoppedAt" | "sandboxStoppedAt") {
    const version = nextVersion(call, new Date())
    const data = { [resource]: new Date(), statusChangedAt: version, updatedAt: version }
    const saved = await prisma.researchVoiceCall.updateMany({ where: voiceCleanupFence(call), data })
    if (saved.count !== 1) race(raceCode)
    call = { ...call, ...data }
  }

  if (cleanup && call.providerCallId && !call.providerStoppedAt) {
    let stopped = false
    try { stopped = (await cleanup.provider.hangup(call.providerCallId)).definite === true } catch { /* Outcome remains unknown. */ }
    // Do not catch a failed receipt: a crash/write failure must retain the lease.
    if (stopped) await recordStop("providerStoppedAt")
  }
  if (cleanup && call.sandboxName && call.sandboxCommandId && !call.sandboxStoppedAt) {
    let stopped = false
    try { await cleanup.stopSandbox(call.sandboxName); stopped = true } catch { /* Outcome remains unknown. */ }
    if (stopped) await recordStop("sandboxStoppedAt")
  }
  if (!call.providerStoppedAt || !call.sandboxStoppedAt) {
    return { callPatch: { status: call.status, transcriptIntegrity: call.transcriptIntegrity }, releaseVoiceLease: false }
  }
  return prisma.$transaction(async (tx) => {
    const version = nextVersion(call, new Date())
    const callPatch = {
      status: call.status === "COMPLETED" ? "COMPLETED" : call.endReason === "LEASE_EXPIRED" ? "EXPIRED" : "FAILED",
      statusChangedAt: version, updatedAt: version,
    }
    const finalized = await tx.researchVoiceCall.updateMany({ where: voiceCleanupFence(call), data: callPatch })
    if (finalized.count !== 1) race(raceCode)
    // A newer session owner is not a cleanup error and must remain untouched.
    const released = await tx.researchSession.updateMany({
      where: { id: sessionId, voiceLeaseId: callId },
      data: { voiceLeaseId: null, voiceLeaseExpiresAt: null, updatedAt: version },
    })
    return { callPatch, releaseVoiceLease: released.count === 1 }
  })
}
