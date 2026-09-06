import { describe, expect, it } from "vitest"
import {
  GUIDED_UX_SCREENSHOT_TOKEN,
  buildScreenshotCases,
} from "@/e2e/screenshot-cases"

describe("guided UX screenshot coverage", () => {
  it("defines deterministic builder and desktop/mobile participant captures", () => {
    const cases = buildScreenshotCases({
      workspaceBase: "/e2e-test-org/e2e-workspace",
      includeGuidedUx: true,
      researchToken: GUIDED_UX_SCREENSHOT_TOKEN,
    })

    expect(cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "guided-study-create.png", prepare: "guided-builder" }),
      expect.objectContaining({
        file: "guided-participant-desktop.png",
        prepare: "participant-chat",
        viewport: { width: 1280, height: 800 },
      }),
      expect.objectContaining({
        file: "guided-participant-mobile.png",
        prepare: "participant-chat",
        viewport: { width: 390, height: 844 },
        fullPage: true,
      }),
    ]))
  })

  it("does not invent public participant coverage without an explicit token", () => {
    const cases = buildScreenshotCases({
      workspaceBase: "/rbcodelabs/compass",
      includeGuidedUx: true,
      researchToken: null,
    })

    expect(cases.map((entry) => entry.file)).toContain("guided-study-create.png")
    expect(cases.some((entry) => entry.file.startsWith("guided-participant-"))).toBe(false)
  })

  it("defines deterministic desktop and mobile shared Discussion captures", () => {
    const cases = buildScreenshotCases({
      workspaceBase: "/e2e-test-org/e2e-workspace",
      includeGuidedUx: false,
      includeSharedDiscussion: true,
      researchToken: null,
    })

    expect(cases).toEqual([
      expect.objectContaining({ file: "shared-discussion-desktop.png", prepare: "roadmap-discussion", viewport: { width: 1280, height: 800 } }),
      expect.objectContaining({ file: "shared-discussion-mobile.png", prepare: "roadmap-discussion", viewport: { width: 390, height: 844 } }),
    ])
  })
})
