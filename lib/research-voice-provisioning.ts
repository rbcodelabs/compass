import type { AppPrismaClient } from "@/lib/db"
import { ResearchVoiceControlPlaneError } from "@/lib/research-voice-control-plane"
import { OpenAIRealtimeProviderError } from "@/lib/research-voice-provider"
import { ResearchVoiceSandboxLaunchError, stopResearchVoiceSandbox } from "@/lib/research-voice-sandbox"
import { terminateResearchVoiceCall } from "@/lib/research-voice-termination"

type ProvisioningPrisma = Pick<AppPrismaClient, "$transaction" | "researchVoiceCall">
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
}) {
  return terminateResearchVoiceCall({
    prisma: input.prisma, callId: input.callId, sessionId: input.sessionId,
    compensation: true, raceCode: "PROVISIONING_RACE", errorCode: input.errorCode,
    creationOutcome: { providerNeverCreated: input.status === "FAILED", sandboxNeverCreated: true },
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
  sandboxNeverCreated?: boolean
  sandboxCommandId?: string
  errorCode: string
}) {
  return terminateResearchVoiceCall({
    prisma: input.prisma, callId: input.callId, sessionId: input.sessionId,
    compensation: true, raceCode: "PROVISIONING_RACE", errorCode: input.errorCode,
    cleanup: { provider: input.provider, stopSandbox: input.stopSandbox },
    creationOutcome: {
      providerCallId: input.providerCallId, sandboxName: input.sandboxName,
      sandboxCommandId: input.sandboxCommandId,
      sandboxStopped: input.sandboxAlreadyStopped,
      sandboxNeverCreated: input.sandboxNeverCreated,
    },
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
        providerCallId: providerError.providerCallId, sandboxName, sandboxAlreadyStopped: false, sandboxNeverCreated: true,
        errorCode: providerError.code,
      })
    } else {
      await terminalizeProvisioning({
        prisma, callId: allocation.call.id, sessionId: allocation.call.sessionId,
        status: providerError.ambiguous ? "UNKNOWN" : "FAILED", errorCode: providerError.code,
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
      providerCallId: providerCall.providerCallId, sandboxName, sandboxAlreadyStopped: false, sandboxNeverCreated: true,
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
      sandboxCommandId: runtime.sandboxCommandId,
      sandboxAlreadyStopped: false, errorCode: "WORKER_STATE_CAS_FAILED",
    })
    throw error
  }
  return { callId: allocation.call.id, answerSdp: providerCall.answerSdp, status: "WORKER_STARTING", replayed: false as const }
}
