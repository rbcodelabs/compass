import { describe, expect, it } from "vitest"
import { MAX_RESEARCH_BODY_BYTES, ResearchRequestBodyError, readBoundedResearchJson } from "@/lib/research-request"

describe("bounded public research JSON", () => {
  it("parses a small JSON object", async () => {
    const request = new Request("https://compass.test/api/research/start", {
      method: "POST",
      body: JSON.stringify({ token: "abc" }),
    })
    await expect(readBoundedResearchJson(request)).resolves.toEqual({ token: "abc" })
  })

  it("rejects malformed JSON", async () => {
    const request = new Request("https://compass.test/api/research/start", { method: "POST", body: "{" })
    await expect(readBoundedResearchJson(request)).rejects.toEqual(
      expect.objectContaining<Partial<ResearchRequestBodyError>>({ status: 400 }),
    )
  })

  it("rejects a declared oversized body before reading it", async () => {
    const request = new Request("https://compass.test/api/research/respond", {
      method: "POST",
      headers: { "content-length": String(MAX_RESEARCH_BODY_BYTES + 1) },
      body: "{}",
    })
    await expect(readBoundedResearchJson(request)).rejects.toEqual(
      expect.objectContaining<Partial<ResearchRequestBodyError>>({ status: 413 }),
    )
  })

  it("rejects oversized UTF-8 content without a content-length header", async () => {
    const request = new Request("https://compass.test/api/research/respond", {
      method: "POST",
      body: JSON.stringify({ padding: "é".repeat(MAX_RESEARCH_BODY_BYTES) }),
    })
    request.headers.delete("content-length")
    await expect(readBoundedResearchJson(request)).rejects.toEqual(
      expect.objectContaining<Partial<ResearchRequestBodyError>>({ status: 413 }),
    )
  })
})
