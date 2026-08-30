export const GUIDED_UX_SCREENSHOT_TOKEN = "guided-ux-screenshot-token-2026-v1"
export const GUIDED_UX_SCREENSHOT_STUDY = "Plan selection usability test"

export type ScreenshotPreparation = "guided-builder" | "participant-chat"

export type ScreenshotCase = {
  file: string
  url: string
  prepare: ScreenshotPreparation
  viewport?: { width: number; height: number }
  fullPage?: boolean
}

export function buildScreenshotCases({
  workspaceBase,
  includeGuidedUx,
  researchToken,
}: {
  workspaceBase: string
  includeGuidedUx: boolean
  researchToken: string | null
}): ScreenshotCase[] {
  if (!includeGuidedUx) return []

  const cases: ScreenshotCase[] = [{
    file: "guided-study-create.png",
    url: `${workspaceBase}/capture/new`,
    prepare: "guided-builder",
  }]
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
