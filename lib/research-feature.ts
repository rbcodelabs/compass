export function isResearchCaptureEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true
  return process.env.COMPASS_RESEARCH_CAPTURE_ENABLED === "1"
}

export function isResearchDiscoveryVoiceEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true
  return process.env.COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED === "1"
}
