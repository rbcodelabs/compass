export const GUIDED_UX_SCREENSHOT_TOKEN = "guided-ux-screenshot-token-2026-v1"
export const GUIDED_UX_SCREENSHOT_STUDY = "Plan selection usability test"

export type ScreenshotPreparation = "guided-builder" | "participant-chat" | "roadmap-discussion" | "settings-nav-sheet"

export type ScreenshotCase = {
  file: string
  url: string
  prepare?: ScreenshotPreparation
  viewport?: { width: number; height: number }
  fullPage?: boolean
  settingsPage?: { heading: string; navLink: string }
}

export function buildScreenshotCases({
  workspaceBase,
  includeGuidedUx,
  includeSharedDiscussion = false,
  includeSettingsShell = false,
  researchToken,
}: {
  workspaceBase: string
  includeGuidedUx: boolean
  includeSharedDiscussion?: boolean
  /** Captures of the shared settings shell: account and organization pages, and the small-screen nav. */
  includeSettingsShell?: boolean
  researchToken: string | null
}): ScreenshotCase[] {
  const cases: ScreenshotCase[] = includeSharedDiscussion ? [
    { file: "shared-discussion-desktop.png", url: `${workspaceBase}/roadmap`, prepare: "roadmap-discussion", viewport: { width: 1280, height: 800 } },
    { file: "shared-discussion-mobile.png", url: `${workspaceBase}/roadmap`, prepare: "roadmap-discussion", viewport: { width: 390, height: 844 } },
  ] : []
  if (includeSettingsShell) {
    // The organization page lives at /{org}/settings, one segment up from the workspace base.
    const orgBase = `/${workspaceBase.split("/").filter(Boolean)[0]}`
    const profile = { heading: "Profile", navLink: "Profile" }
    const organization = { heading: "Organization Settings", navLink: "Organization settings" }
    cases.push(
      { file: "settings-account-desktop.png", url: "/settings/profile", settingsPage: profile, viewport: { width: 1280, height: 800 } },
      { file: "settings-organization-desktop.png", url: `${orgBase}/settings`, settingsPage: organization, viewport: { width: 1280, height: 800 } },
      { file: "settings-nav-mobile.png", url: "/settings/profile", settingsPage: profile, viewport: { width: 390, height: 844 } },
      { file: "settings-nav-mobile-open.png", url: "/settings/profile", settingsPage: profile, prepare: "settings-nav-sheet", viewport: { width: 390, height: 844 } },
    )
  }
  if (!includeGuidedUx) return cases

  cases.push({
    file: "guided-study-create.png",
    url: `${workspaceBase}/capture/new`,
    prepare: "guided-builder",
  })
  if (!researchToken) return cases

  const participantUrl = `/research/${encodeURIComponent(researchToken)}`
  cases.push(
    {
      file: "guided-participant-desktop.png",
      url: participantUrl,
      prepare: "participant-chat",
      viewport: { width: 1280, height: 800 },
    },
    {
      file: "guided-participant-mobile.png",
      url: participantUrl,
      prepare: "participant-chat",
      viewport: { width: 390, height: 844 },
      fullPage: true,
    },
  )
  return cases
}
