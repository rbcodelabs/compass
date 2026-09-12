export function isResearchCaptureEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true
  return process.env.COMPASS_RESEARCH_CAPTURE_ENABLED === "1"
}

export function isPmInterviewEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return process.env.COMPASS_PM_INTERVIEW_ENABLED !== "0"
  return process.env.COMPASS_PM_INTERVIEW_ENABLED === "1"
}

export function isResearchAuthoritativeVoiceEnabled(): boolean {
  return process.env.COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED === "1"
}

export function isResearchLegacyVoiceHarnessEnabled(): boolean {
  return process.env.NODE_ENV !== "production" &&
    process.env.E2E_FUNCTIONAL === "1" &&
    isResearchAuthoritativeVoiceEnabled()
}

// Browser transcripts are participant-submitted evidence, not authoritative voice events.
export function isResearchBrowserVoiceEnabled(): boolean {
  return process.env.COMPASS_RESEARCH_BROWSER_VOICE_ENABLED === "1"
}

export function isResearchParticipantVoiceEnabled(): boolean {
  return isResearchBrowserVoiceEnabled() || isResearchLegacyVoiceHarnessEnabled()
}

export function isResearchDiscoveryVoiceEnabled(): boolean {
  if (isResearchBrowserVoiceEnabled()) return true
  if (!isResearchAuthoritativeVoiceEnabled()) return false
  if (process.env.NODE_ENV !== "production") return true
  return process.env.COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED === "1"
}
