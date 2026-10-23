import { afterEach, describe, expect, it, vi } from "vitest"
import {
  isResearchAuthoritativeVoiceEnabled,
  isResearchBrowserVoiceEnabled,
  isResearchCaptureEnabled,
  isResearchDiscoveryVoiceEnabled,
  isResearchLegacyVoiceHarnessEnabled,
  isResearchParticipantVoiceEnabled,
  isPmInterviewEnabled,
} from "@/lib/research-feature"
import { setModules } from "./helpers/modules"

const WS = "ws-1"

describe("research capture feature gate", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("is off until the workspace enables the research capture module", async () => {
    setModules({ research_capture: false })
    expect(await isResearchCaptureEnabled(WS)).toBe(false)
    setModules({ research_capture: true })
    expect(await isResearchCaptureEnabled(WS)).toBe(true)
  })

  it("gates PM interviews independently of Capture", async () => {
    setModules({ research_capture: true, pm_interview: false })
    expect(await isResearchCaptureEnabled(WS)).toBe(true)
    expect(await isPmInterviewEnabled(WS)).toBe(false)
    setModules({ pm_interview: true })
    expect(await isPmInterviewEnabled(WS)).toBe(true)
  })

  it("fails browser voice closed by default and enables it only through its module", async () => {
    expect(await isResearchBrowserVoiceEnabled(WS)).toBe(false)
    expect(await isResearchParticipantVoiceEnabled(WS)).toBe(false)
    setModules({ research_voice_browser: true })
    expect(await isResearchBrowserVoiceEnabled(WS)).toBe(true)
    expect(await isResearchParticipantVoiceEnabled(WS)).toBe(true)
  })

  it("fails discovery voice closed independently of Capture", async () => {
    setModules({ research_capture: true, research_voice_discovery: false })
    expect(await isResearchCaptureEnabled(WS)).toBe(true)
    expect(await isResearchDiscoveryVoiceEnabled(WS)).toBe(false)
  })

  it("fails authoritative voice closed until explicitly enabled", async () => {
    vi.stubEnv("NODE_ENV", "test")
    expect(await isResearchAuthoritativeVoiceEnabled(WS)).toBe(false)
    expect(await isResearchDiscoveryVoiceEnabled(WS)).toBe(false)
  })

  it("does not let authoritative voice alone enable participant voice", async () => {
    vi.stubEnv("NODE_ENV", "test")
    setModules({ research_voice_authoritative: true })
    expect(await isResearchAuthoritativeVoiceEnabled(WS)).toBe(true)
    expect(await isResearchParticipantVoiceEnabled(WS)).toBe(false)
  })

  it("enables discovery voice through the browser module, or through authoritative plus discovery", async () => {
    setModules({ research_voice_discovery: true })
    expect(await isResearchDiscoveryVoiceEnabled(WS)).toBe(false)
    setModules({ research_voice_authoritative: true })
    expect(await isResearchDiscoveryVoiceEnabled(WS)).toBe(true)
    setModules({ research_voice_discovery: false, research_voice_authoritative: false, research_voice_browser: true })
    expect(await isResearchDiscoveryVoiceEnabled(WS)).toBe(true)
  })

  it("does not enable authoritative discovery when only the authoritative module is on", async () => {
    setModules({ research_voice_authoritative: true, research_voice_discovery: false })
    expect(await isResearchDiscoveryVoiceEnabled(WS)).toBe(false)
  })

  it("fails every voice module closed while research capture is off", async () => {
    setModules({
      research_capture: false,
      research_voice_authoritative: true,
      research_voice_browser: true,
      research_voice_discovery: true,
    })
    expect(await isResearchAuthoritativeVoiceEnabled(WS)).toBe(false)
    expect(await isResearchBrowserVoiceEnabled(WS)).toBe(false)
    expect(await isResearchParticipantVoiceEnabled(WS)).toBe(false)
    expect(await isResearchDiscoveryVoiceEnabled(WS)).toBe(false)
  })

  it("never enables the legacy browser voice harness in production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("E2E_FUNCTIONAL", "1")
    setModules({ research_voice_authoritative: true })
    expect(await isResearchLegacyVoiceHarnessEnabled(WS)).toBe(false)
  })

  it("enables the legacy harness only for non-production functional E2E with the authoritative module", async () => {
    vi.stubEnv("NODE_ENV", "test")
    setModules({ research_voice_authoritative: true })
    vi.stubEnv("E2E_FUNCTIONAL", "")
    expect(await isResearchLegacyVoiceHarnessEnabled(WS)).toBe(false)
    vi.stubEnv("E2E_FUNCTIONAL", "1")
    expect(await isResearchLegacyVoiceHarnessEnabled(WS)).toBe(true)
    expect(await isResearchParticipantVoiceEnabled(WS)).toBe(true)
    setModules({ research_voice_authoritative: false })
    expect(await isResearchLegacyVoiceHarnessEnabled(WS)).toBe(false)
  })
})
