import { describe, expect, it } from "vitest"
import { POST as start } from "@/app/api/research/start/route"
import { POST as respond } from "@/app/api/research/respond/route"
import { POST as complete } from "@/app/api/research/complete/route"

function request(body: unknown) {
  return new Request("http://localhost/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}

describe("research participant API validation", () => {
  it("requires a study token to start", async () => {
    const response = await start(request({}))
    expect(response.status).toBe(400)
  })

  it("requires token, session, and transcript context to respond", async () => {
    const response = await respond(request({ token: "token" }))
    expect(response.status).toBe(400)
  })

  it("requires token, session, and messages to complete", async () => {
    const response = await complete(request({ token: "token", sessionId: "session", messages: [] }))
    expect(response.status).toBe(400)
  })
})
