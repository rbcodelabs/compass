export const RESEARCH_ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/heic,.heic,application/pdf"
export type ResearchModelAttachmentMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "application/pdf"
export function isResearchModelAttachmentMime(mime: string): mime is ResearchModelAttachmentMime {
  return ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"].includes(mime)
}
export function isResearchVoiceImageMime(mime: string) {
  return ["image/png", "image/jpeg", "image/webp"].includes(mime)
}
