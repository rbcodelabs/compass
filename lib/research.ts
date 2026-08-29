import { createHash, randomBytes } from "crypto"

export type ResearchGuideItem = { id: string; text: string }

export function hashResearchToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export function createResearchToken() {
  const token = randomBytes(32).toString("base64url")
  return { token, tokenHash: hashResearchToken(token) }
}

export function parseResearchGuide(value: string): ResearchGuideItem[] {
  return value.split("\n").map((text) => text.trim()).filter(Boolean).map((text, index) => ({ id: String(index + 1), text }))
}

export function buildResearchPrompt(guide: ResearchGuideItem[], targetMinutes: number) {
  const questions = guide.map((item, index) => `${index + 1}. ${item.text}`).join("\n")
  return `You are an expert qualitative researcher conducting a customer interview for a Compass research study. The interview should take about ${targetMinutes} minutes.\n\nDiscussion guide:\n${questions}\n\nAsk one question at a time. Listen for concrete past experiences, behaviors, motivations, and pain points. Probe vague answers before moving on. Keep responses to 1-3 sentences, stay neutral, and never validate the participant's answer. Once the guide is covered, ask what they would change, then thank them and end the interview. Respond only with the next interviewer message.`
}
