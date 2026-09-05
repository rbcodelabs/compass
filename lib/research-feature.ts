export function isResearchCaptureEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true
  return process.env.COMPASS_RESEARCH_CAPTURE_ENABLED === "1"
}

export function isResearchAuthoritativeVoiceEnabled(): boolean {
  return process.env.COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED === "1"
}

export function isResearchLegacyVoiceHarnessEnabled(): boolean {
  return process.env.NODE_ENV !== "production" &&
    process.env.E2E_FUNCTIONAL === "1" &&
    isResearchAuthoritativeVoiceEnabled()
}

export function isResearchDiscoveryVoiceEnabled(): boolean {
  if (!isResearchAuthoritativeVoiceEnabled()) return false
  if (process.env.NODE_ENV !== "production") return true
  return process.env.COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED === "1"
}
