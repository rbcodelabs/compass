import { describe, expect, it } from "vitest"

import { AGENT_VIEW_COOKIE, parseAgentView, resolveInitialAgentView } from "@/lib/agent-view-pref"

describe("parseAgentView", () => {
  it("reads an explicit board", () => {
    expect(parseAgentView("board")).toBe("board")
  })

  it.each([undefined, "", "chat", "BOARD", "garbled", "1"])("falls back to chat for %j", (value) => {
    expect(parseAgentView(value)).toBe("chat")
  })
})

describe("resolveInitialAgentView", () => {
  it("honours the saved board view on a plain /agent load", () => {
    expect(resolveInitialAgentView("board", undefined)).toBe("board")
  })

  it("shows the chat when a conversation was asked for by URL, whatever the saved view (a deep link means the chat)", () => {
    expect(resolveInitialAgentView("board", "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312")).toBe("chat")
  })

  it("defaults to chat", () => {
    expect(resolveInitialAgentView(undefined, undefined)).toBe("chat")
  })
})

it("uses a stable cookie name (the server page and the client toggle must agree)", () => {
  expect(AGENT_VIEW_COOKIE).toBe("agent_view")
})
