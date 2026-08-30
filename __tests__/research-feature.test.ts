import { afterEach, describe, expect, it, vi } from "vitest"
import { isResearchCaptureEnabled } from "@/lib/research-feature"

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

  it("stays available in development and tests", () => {
    vi.stubEnv("NODE_ENV", "test")
    expect(isResearchCaptureEnabled()).toBe(true)
  })
})
