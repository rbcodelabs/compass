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

  it("adds no settings shell captures unless asked", () => {
    const cases = buildScreenshotCases({
      workspaceBase: "/e2e-test-org/e2e-workspace",
      includeGuidedUx: false,
      researchToken: null,
    })

    expect(cases).toEqual([])
  })

  it("defines account, organization and small-screen settings nav captures", () => {
    const cases = buildScreenshotCases({
      workspaceBase: "/e2e-test-org/e2e-workspace",
      includeGuidedUx: false,
      includeSettingsShell: true,
      researchToken: null,
    })

    expect(cases).toEqual([
      expect.objectContaining({ file: "settings-account-desktop.png", url: "/settings/profile", viewport: { width: 1280, height: 800 } }),
      expect.objectContaining({ file: "settings-organization-desktop.png", url: "/e2e-test-org/settings", viewport: { width: 1280, height: 800 } }),
      expect.objectContaining({ file: "settings-nav-mobile.png", url: "/settings/profile", viewport: { width: 390, height: 844 } }),
      expect.objectContaining({ file: "settings-nav-mobile-open.png", url: "/settings/profile", prepare: "settings-nav-sheet", viewport: { width: 390, height: 844 } }),
    ])
    // Only the sheet capture needs the nav opened first.
    expect(cases.filter((entry) => entry.prepare).map((entry) => entry.file)).toEqual(["settings-nav-mobile-open.png"])
  })

  it("derives the organization page from the workspace base for any org slug", () => {
    const cases = buildScreenshotCases({
      workspaceBase: "/rbcodelabs/compass",
      includeGuidedUx: false,
      includeSettingsShell: true,
      researchToken: null,
    })

    expect(cases.find((entry) => entry.file === "settings-organization-desktop.png")?.url).toBe("/rbcodelabs/settings")
  })

  it("keeps the settings captures alongside the other opt-in sets without reordering them", () => {
    const files = buildScreenshotCases({
      workspaceBase: "/e2e-test-org/e2e-workspace",
      includeGuidedUx: true,
      includeSharedDiscussion: true,
      includeSettingsShell: true,
      researchToken: GUIDED_UX_SCREENSHOT_TOKEN,
    }).map((entry) => entry.file)

    expect(files).toEqual([
      "shared-discussion-desktop.png",
      "shared-discussion-mobile.png",
      "settings-account-desktop.png",
      "settings-organization-desktop.png",
      "settings-nav-mobile.png",
      "settings-nav-mobile-open.png",
      "guided-study-create.png",
      "guided-participant-desktop.png",
      "guided-participant-mobile.png",
    ])
  })
})
