import { afterEach, describe, expect, it, vi } from "vitest"
import {
  isResearchAuthoritativeVoiceEnabled,
  isResearchCaptureEnabled,
  isResearchDiscoveryVoiceEnabled,
  isResearchLegacyVoiceHarnessEnabled,
  isPmInterviewEnabled,
} from "@/lib/research-feature"

describe("research capture feature gate", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("is fail-closed in production until explicitly enabled", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_CAPTURE_ENABLED", "")
    expect(isResearchCaptureEnabled()).toBe(false)
  })

  it("can be enabled explicitly for the deployed real-agent gate", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_CAPTURE_ENABLED", "1")
    expect(isResearchCaptureEnabled()).toBe(true)
  })

  it("fails PM interviews closed in production independently of Capture", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_CAPTURE_ENABLED", "1")
    vi.stubEnv("COMPASS_PM_INTERVIEW_ENABLED", "")
    expect(isResearchCaptureEnabled()).toBe(true)
    expect(isPmInterviewEnabled()).toBe(false)
    vi.stubEnv("COMPASS_PM_INTERVIEW_ENABLED", "1")
    expect(isPmInterviewEnabled()).toBe(true)
  })

  it("stays available in development and tests", () => {
    vi.stubEnv("NODE_ENV", "test")
    expect(isResearchCaptureEnabled()).toBe(true)
  })

  it("fails discovery voice closed in production independently of Capture", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_CAPTURE_ENABLED", "1")
    vi.stubEnv("COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED", "")
    expect(isResearchCaptureEnabled()).toBe(true)
    expect(isResearchDiscoveryVoiceEnabled()).toBe(false)
  })

  it("fails authoritative voice closed in every environment until explicitly enabled", () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "")
    expect(isResearchAuthoritativeVoiceEnabled()).toBe(false)
    expect(isResearchDiscoveryVoiceEnabled()).toBe(false)
  })

  it("enables discovery voice only when both production voice gates are explicit", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED", "1")
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "")
    expect(isResearchDiscoveryVoiceEnabled()).toBe(false)
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "1")
    expect(isResearchAuthoritativeVoiceEnabled()).toBe(true)
    expect(isResearchDiscoveryVoiceEnabled()).toBe(true)
  })

  it("allows discovery voice by default outside production only after the global gate is enabled", () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED", "")
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "1")
    expect(isResearchDiscoveryVoiceEnabled()).toBe(true)
  })

  it("never enables the legacy browser voice harness in production", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "1")
    vi.stubEnv("E2E_FUNCTIONAL", "1")
    expect(isResearchLegacyVoiceHarnessEnabled()).toBe(false)
  })

  it("enables the legacy harness only for explicit non-production functional E2E", () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "1")
    vi.stubEnv("E2E_FUNCTIONAL", "")
    expect(isResearchLegacyVoiceHarnessEnabled()).toBe(false)
    vi.stubEnv("E2E_FUNCTIONAL", "1")
    expect(isResearchLegacyVoiceHarnessEnabled()).toBe(true)
  })
})
