import { isModuleEnabled } from "@/lib/modules/server"

/**
 * Workspace-scoped research and PM-interview feature checks, built on workspace modules (lib/modules). Every function takes the
 * workspace the work belongs to: a study's workspaceId, the workspace a page was routed to, or a session's study.
 *
 * Voice stays fail-closed on every path:
 *  - the three voice modules default off and each requires research capture (and discovery requires authoritative voice), so a
 *    missing row, an unreadable table or a disabled requirement all read as "disabled";
 *  - the legacy browser-authoritative harness remains confined to non-production AND the functional e2e run
 *    (E2E_FUNCTIONAL=1): those are runtime-environment guards on a test-only transport, not product gating, and they are
 *    deliberately kept as environment checks.
 */

export async function isResearchCaptureEnabled(workspaceId: string): Promise<boolean> {
  return isModuleEnabled(workspaceId, "research_capture")
}

export async function isPmInterviewEnabled(workspaceId: string): Promise<boolean> {
  return isModuleEnabled(workspaceId, "pm_interview")
}

export async function isResearchAuthoritativeVoiceEnabled(workspaceId: string): Promise<boolean> {
  return isModuleEnabled(workspaceId, "research_voice_authoritative")
}

export async function isResearchLegacyVoiceHarnessEnabled(workspaceId: string): Promise<boolean> {
  return process.env.NODE_ENV !== "production" &&
    process.env.E2E_FUNCTIONAL === "1" &&
    await isResearchAuthoritativeVoiceEnabled(workspaceId)
}

// Browser transcripts are participant-submitted evidence, not authoritative voice events.
export async function isResearchBrowserVoiceEnabled(workspaceId: string): Promise<boolean> {
  return isModuleEnabled(workspaceId, "research_voice_browser")
}

export async function isResearchParticipantVoiceEnabled(workspaceId: string): Promise<boolean> {
  return (await isResearchBrowserVoiceEnabled(workspaceId)) || (await isResearchLegacyVoiceHarnessEnabled(workspaceId))
}

export async function isResearchDiscoveryVoiceEnabled(workspaceId: string): Promise<boolean> {
  if (await isResearchBrowserVoiceEnabled(workspaceId)) return true
  // The discovery module requires the authoritative-voice module, so this is both gates.
  return isModuleEnabled(workspaceId, "research_voice_discovery")
}
