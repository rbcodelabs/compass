import type { PrismaClient } from "@prisma/client"
import { ResearchVoiceControlPlaneError } from "@/lib/research-voice-control-plane"
import { OpenAIRealtimeProviderError } from "@/lib/research-voice-provider"
import { ResearchVoiceSandboxLaunchError, stopResearchVoiceSandbox } from "@/lib/research-voice-sandbox"

type ProvisioningPrisma = Pick<PrismaClient, "$transaction" | "researchVoiceCall">
type Provider = {
  createCall(input: { offerSdp: string; model: string }): Promise<{ answerSdp: string; providerCallId: string }>
  hangup(providerCallId: string): Promise<{ definite: true }>
}
type Launcher = (input: {
  callId: string
  providerCallId: string
  workerToken: string
  leaseExpiresAt: Date
}) => Promise<{ sandboxName: string; sandboxCommandId: string }>

async function terminalizeProvisioning(input: {
  prisma: ProvisioningPrisma
  callId: string
  sessionId: string
  status: "FAILED" | "UNKNOWN"
  errorCode: string
  expectedStatus: "PROVISIONING" | "DISCONNECTING"
  statusChangedAt?: Date
  providerCallId?: string
  sandboxName?: string
  providerStoppedAt?: Date | null
  sandboxStoppedAt?: Date | null
}) {
  const transitionedAt = new Date()
  await input.prisma.$transaction(async (tx) => {
    const updated = await tx.researchVoiceCall.updateMany({
      where: {
        id: input.callId,
        sessionId: input.sessionId,
        status: input.expectedStatus,
        ...(input.statusChangedAt ? { statusChangedAt: input.statusChangedAt } : {}),
        ...(input.providerCallId ? { providerCallId: input.providerCallId, sandboxName: input.sandboxName } : {}),
      },
      data: {
        status: input.status,
        transcriptIntegrity: "DEGRADED",
        errorCode: input.errorCode,
        endedAt: transitionedAt,
        statusChangedAt: transitionedAt,
        updatedAt: transitionedAt,
        answerSdp: null,
        ...(input.providerStoppedAt !== undefined ? { providerStoppedAt: input.providerStoppedAt } : {}),
        ...(input.sandboxStoppedAt !== undefined ? { sandboxStoppedAt: input.sandboxStoppedAt } : {}),
      },
    })
    if (updated.count !== 1) throw new ResearchVoiceControlPlaneError("Voice provisioning changed concurrently", 409, "PROVISIONING_RACE")
    const released = await tx.researchSession.updateMany({
      where: { id: input.sessionId, voiceLeaseId: input.callId },
      data: { voiceLeaseId: null, voiceLeaseExpiresAt: null, updatedAt: transitionedAt },
    })
    if (released.count !== 1) throw new ResearchVoiceControlPlaneError("Voice lease changed concurrently", 409, "PROVISIONING_RACE")
  })
}

async function compensateCreatedProviderCall(input: {
  prisma: ProvisioningPrisma
  provider: Provider
  stopSandbox: (name: string) => Promise<unknown>
  callId: string
  sessionId: string
  providerCallId: string
  sandboxName: string
  sandboxAlreadyStopped: boolean
  errorCode: string
}) {
  const current = await input.prisma.researchVoiceCall.findUnique({ where: { id: input.callId } })
  if (!current || current.sessionId !== input.sessionId ||
      !["PROVISIONING", "PROVIDER_CREATED"].includes(current.status) ||
      (current.providerCallId && current.providerCallId !== input.providerCallId)) {
    throw new ResearchVoiceControlPlaneError("Voice provisioning changed concurrently", 409, "PROVISIONING_RACE")
  }
  const cleanupStartedAt = new Date()
  // Publish cleanup ownership and resource provenance before issuing destructive I/O.
  // A worker that advanced concurrently wins the fence and remains untouched.
  const fenced = await input.prisma.researchVoiceCall.updateMany({
    where: {
      id: input.callId, sessionId: input.sessionId, status: current.status,
      statusChangedAt: current.statusChangedAt, providerCallId: current.providerCallId,
      sandboxName: current.sandboxName, sandboxCommandId: current.sandboxCommandId,
    },
    data: {
      status: "DISCONNECTING", statusChangedAt: cleanupStartedAt, updatedAt: cleanupStartedAt,
      providerCallId: input.providerCallId, sandboxName: input.sandboxName,
      transcriptIntegrity: "DEGRADED", errorCode: input.errorCode, answerSdp: null,
    },
  })
  if (fenced.count !== 1) throw new ResearchVoiceControlPlaneError("Voice provisioning changed concurrently", 409, "PROVISIONING_RACE")
  let providerStoppedAt: Date | null = null
  try {
    await input.provider.hangup(input.providerCallId)
    providerStoppedAt = new Date()
  } catch {
    // Retain the provider identity for the durable cleanup retry.
  }
  let sandboxStopped = input.sandboxAlreadyStopped
  if (!sandboxStopped) {
    try {
      await input.stopSandbox(input.sandboxName)
      sandboxStopped = true
    } catch {
      sandboxStopped = false
    }
  }
  await terminalizeProvisioning({
    prisma: input.prisma,
    callId: input.callId,
    sessionId: input.sessionId,
    status: sandboxStopped && providerStoppedAt ? "FAILED" : "UNKNOWN",
    errorCode: input.errorCode,
    expectedStatus: "DISCONNECTING", statusChangedAt: cleanupStartedAt,
    providerCallId: input.providerCallId, sandboxName: input.sandboxName,
    providerStoppedAt, sandboxStoppedAt: sandboxStopped ? new Date() : null,
  })
}

export async function provisionAllocatedResearchVoiceCall({
  prisma,
  allocation,
  provider,
  launcher,
  stopSandbox = stopResearchVoiceSandbox,
  model,
  offerSdp,
}: {
  prisma: ProvisioningPrisma
  allocation: {
    replayed: boolean
    workerToken: string | null
    call: {
      id: string
      sessionId: string
      status: string
      leaseExpiresAt: Date
      answerSdp: string | null
      providerCallId?: string | null
    }
  }
  provider: Provider
  launcher: Launcher
  stopSandbox?: (name: string) => Promise<unknown>
  model: string
  offerSdp: string
}) {
  const sandboxName = `compass-research-voice-${allocation.call.id}`
  if (allocation.replayed) {
    if (allocation.call.status === "PROVIDER_CREATED" && allocation.call.providerCallId) {
      return { callId: allocation.call.id, answerSdp: null, status: "PROVISIONING_IN_PROGRESS", replayed: true as const }
    }
    if (!allocation.call.answerSdp) throw new ResearchVoiceControlPlaneError("Voice allocation replay is unavailable", 409, "REPLAY_UNAVAILABLE")
    return { callId: allocation.call.id, answerSdp: allocation.call.answerSdp, status: allocation.call.status, replayed: true as const }
  }
  if (!allocation.workerToken || allocation.call.status !== "PROVISIONING") {
    throw new ResearchVoiceControlPlaneError("Invalid voice allocation state", 409, "INVALID_ALLOCATION_STATE")
  }

  let providerCall: { answerSdp: string; providerCallId: string }
  try {
    providerCall = await provider.createCall({ offerSdp, model })
  } catch (error) {
    const providerError = error instanceof OpenAIRealtimeProviderError ? error :
      new OpenAIRealtimeProviderError("OpenAI call creation outcome is unknown", "PROVIDER_CREATE_AMBIGUOUS", true)
    if (providerError.providerCallId) {
      await compensateCreatedProviderCall({
        prisma, provider, stopSandbox, callId: allocation.call.id, sessionId: allocation.call.sessionId,
        providerCallId: providerError.providerCallId, sandboxName, sandboxAlreadyStopped: false,
        errorCode: providerError.code,
      })
    } else {
      await terminalizeProvisioning({
        prisma, callId: allocation.call.id, sessionId: allocation.call.sessionId,
        status: providerError.ambiguous ? "UNKNOWN" : "FAILED", errorCode: providerError.code,
        expectedStatus: "PROVISIONING",
      })
    }
    throw providerError
  }

  const providerStoredAt = new Date()
  try {
    const providerStored = await prisma.researchVoiceCall.updateMany({
    where: { id: allocation.call.id, sessionId: allocation.call.sessionId, status: "PROVISIONING", providerCallId: null },
    data: {
      providerCallId: providerCall.providerCallId, answerSdp: providerCall.answerSdp,
      status: "PROVIDER_CREATED", statusChangedAt: providerStoredAt, updatedAt: providerStoredAt,
    },
  })
    if (providerStored.count !== 1) throw new ResearchVoiceControlPlaneError("Voice provisioning changed concurrently", 409, "PROVISIONING_RACE")
  } catch (error) {
    await compensateCreatedProviderCall({
      prisma, provider, stopSandbox, callId: allocation.call.id, sessionId: allocation.call.sessionId,
      providerCallId: providerCall.providerCallId, sandboxName, sandboxAlreadyStopped: false,
      errorCode: "PROVIDER_STATE_CAS_FAILED",
    })
    throw error
  }

  let runtime: { sandboxName: string; sandboxCommandId: string }
  try {
    runtime = await launcher({
      callId: allocation.call.id, providerCallId: providerCall.providerCallId,
      workerToken: allocation.workerToken, leaseExpiresAt: allocation.call.leaseExpiresAt,
    })
  } catch (error) {
    const launchError = error instanceof ResearchVoiceSandboxLaunchError || (
      error instanceof Error && error.name === "ResearchVoiceSandboxLaunchError" &&
      "sandboxName" in error && "cleanupDefinite" in error
    ) ? error as ResearchVoiceSandboxLaunchError : null
    await compensateCreatedProviderCall({
      prisma, provider, stopSandbox, callId: allocation.call.id, sessionId: allocation.call.sessionId,
      providerCallId: providerCall.providerCallId,
      sandboxName: launchError?.sandboxName ?? sandboxName,
      sandboxAlreadyStopped: launchError?.cleanupDefinite ?? false,
      errorCode: "WORKER_START_FAILED",
    })
    throw error
  }

  const workerStoredAt = new Date()
  try {
    const workerStored = await prisma.researchVoiceCall.updateMany({
    where: {
      id: allocation.call.id, sessionId: allocation.call.sessionId,
      status: "PROVIDER_CREATED", providerCallId: providerCall.providerCallId,
    },
    data: {
      sandboxName: runtime.sandboxName, sandboxCommandId: runtime.sandboxCommandId,
      status: "WORKER_STARTING", statusChangedAt: workerStoredAt, updatedAt: workerStoredAt,
    },
  })
    if (workerStored.count !== 1) throw new ResearchVoiceControlPlaneError("Voice worker state changed concurrently", 409, "PROVISIONING_RACE")
  } catch (error) {
    const current = await prisma.researchVoiceCall.findUnique({ where: { id: allocation.call.id } })
    if (current?.sessionId === allocation.call.sessionId && current.providerCallId === providerCall.providerCallId &&
        current.sandboxName === runtime.sandboxName && current.sandboxCommandId === runtime.sandboxCommandId &&
        ["WORKER_STARTING", "READY", "ACTIVE", "DISCONNECTING"].includes(current.status)) {
      return { callId: current.id, answerSdp: null, status: current.status, replayed: true as const }
    }
    await compensateCreatedProviderCall({
      prisma, provider, stopSandbox, callId: allocation.call.id, sessionId: allocation.call.sessionId,
      providerCallId: providerCall.providerCallId, sandboxName: runtime.sandboxName,
      sandboxAlreadyStopped: false, errorCode: "WORKER_STATE_CAS_FAILED",
    })
    throw error
  }
  return { callId: allocation.call.id, answerSdp: providerCall.answerSdp, status: "WORKER_STARTING", replayed: false as const }
}
