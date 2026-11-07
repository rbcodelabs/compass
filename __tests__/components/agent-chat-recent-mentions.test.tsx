// @vitest-environment jsdom
//
// The Recent row above the composer (components/agent/recent-mentions.tsx) in AgentChat.
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))

import { AgentChat } from "@/components/agent/agent-chat"

const OPP = "11111111-1111-4111-8111-111111111111"

function props(initialMessages: Array<{ id: string; role: "user" | "assistant"; content: string }>) {
  return {
    workspaceId: "ws-1",
    basePath: "/acme/product",
    conversations: [],
    activeConversationId: null,
    initialMessages,
    userInitials: "RB",
    userId: "user-1",
  }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/panels/entity-summary")) {
        return new Response(
          JSON.stringify({ type: "opportunity", id: OPP, title: "Onboarding drop-off", typeLabel: "Opportunity", status: "EXPLORING", meta: null, description: null }),
          { status: 200 },
        )
      }
      return new Response("{}", { status: 200 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AgentChat recent mentions", () => {
  it("shows a pill for an entity the assistant linked, and an external host pill", async () => {
    render(
      <AgentChat
        {...props([
          { id: "m1", role: "user", content: "what is blocking activation?" },
          { id: "m2", role: "assistant", content: "See [Onboarding drop-off](/acme/product/discovery/" + OPP + ") and https://github.com/a/b/pull/1" },
        ])}
      />,
    )
    const row = await screen.findByTestId("agent-recent-mentions")
    expect(row).toBeInTheDocument()
    await waitFor(() => expect(row).toHaveTextContent("Onboarding drop-off"))
    expect(row).toHaveTextContent("github.com")
  })

  it("renders no row when the assistant has linked nothing", () => {
    render(<AgentChat {...props([{ id: "m1", role: "assistant", content: "Nothing to link here." }])} />)
    expect(screen.queryByTestId("agent-recent-mentions")).toBeNull()
  })
})
