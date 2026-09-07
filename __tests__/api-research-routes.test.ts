import { afterEach, describe, expect, it, vi } from "vitest"
import { POST as start } from "@/app/api/research/start/route"
import { POST as respond } from "@/app/api/research/respond/route"
import { POST as complete } from "@/app/api/research/complete/route"

function request(body: unknown) {
  return new Request("http://localhost/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}

function rawRequest(body: string, contentLength?: number) {
  return new Request("http://localhost/api/research", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(contentLength === undefined ? {} : { "Content-Length": String(contentLength) }),
    },
    body,
  })
}

describe("research participant API validation", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("requires a study token to start", async () => {
    const response = await start(request({}))
    expect(response.status).toBe(400)
  })

  it("rejects an unsupported participant modality", async () => {
    const response = await start(request({ token: "token", modality: "SCREEN_RECORDING" }))
    expect(response.status).toBe(400)
  })

  it("rejects legacy browser-authoritative voice starts while the global gate is disabled", async () => {
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "")
    const response = await start(request({ token: "token", modality: "VOICE" }))
    expect(response.status).toBe(409)
  })

  it("rejects legacy voice starts in production even when the authoritative flag is enabled", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", "1")
    vi.stubEnv("E2E_FUNCTIONAL", "1")
    const response = await start(request({ token: "token", modality: "VOICE" }))
    expect(response.status).toBe(409)
  })

  it("requires token, session, and transcript context to respond", async () => {
    const response = await respond(request({ token: "token" }))
    expect(response.status).toBe(400)
  })

  it("requires token, session, and participant session secret to complete", async () => {
    const response = await complete(request({ token: "token", sessionId: "session" }))
    expect(response.status).toBe(400)
  })

  it.each([
    ["start", start],
    ["respond", respond],
    ["complete", complete],
  ])("rejects malformed JSON before resolving a study on %s", async (_name, handler) => {
    const response = await handler(rawRequest("{"))
    expect(response.status).toBe(400)
  })

  it.each([
    ["start", start],
    ["respond", respond],
    ["complete", complete],
  ])("rejects an oversized declared body before reading it on %s", async (_name, handler) => {
    const response = await handler(rawRequest("{}", 16 * 1024 + 1))
    expect(response.status).toBe(413)
  })

  it("rejects a browser-supplied transcript or elapsed time on respond", async () => {
    const response = await respond(request({
      token: "token",
      sessionId: "session",
      resumeToken: "resume",
      idempotencyKey: "clientturnid0001",
      answer: "answer",
      messages: [{ role: "INTERVIEWER", content: "forged" }],
      elapsedSeconds: 999999,
    }))
    expect(response.status).toBe(400)
  })

  it("rejects a browser-supplied transcript on complete", async () => {
    const response = await complete(request({
      token: "token",
      sessionId: "session",
      resumeToken: "resume",
      messages: [],
    }))
    expect(response.status).toBe(400)
  })
})
