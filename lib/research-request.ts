export const MAX_RESEARCH_BODY_BYTES = 16 * 1024

export class ResearchRequestBodyError extends Error {
  constructor(message: string, readonly status: 400 | 413) {
    super(message)
    this.name = "ResearchRequestBodyError"
  }
}

export async function readBoundedResearchJson(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESEARCH_BODY_BYTES) {
    throw new ResearchRequestBodyError("Request body is too large", 413)
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_RESEARCH_BODY_BYTES) {
    throw new ResearchRequestBodyError("Request body is too large", 413)
  }
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ResearchRequestBodyError("A JSON object is required", 400)
    }
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof ResearchRequestBodyError) throw error
    throw new ResearchRequestBodyError("Malformed JSON", 400)
  }
}
