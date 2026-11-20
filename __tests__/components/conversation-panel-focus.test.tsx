// @vitest-environment jsdom
//
// TASK-195 S3: the panel hands the `?comment=` message id to AgentChat, only when it is a well-formed id.
import React from "react"
import { cleanup, render, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ search: "", chatProps: [] as Record<string, unknown>[] }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/acme/core/discovery/OPP-3",
  useSearchParams: () => new URLSearchParams(state.search),
}))
// Stable references: the provider's effects depend on `panel`, so a new object per render would re-run them forever.
vi.mock("@/components/panels/panel-context", () => {
  const value = { panel: { type: "conversation", id: "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312" }, openPanel: vi.fn(), closePanel: vi.fn() }
  return { usePanelContext: () => value }
})
vi.mock("@/components/thinking-model/thinking-model-provider", () => {
  const entity = { singular: "Item", lower: "item" }
  const labels = { objective: entity, keyResult: entity, opportunity: entity, solution: entity }
  return { useLabels: () => labels }
})
vi.mock("@/components/agent/agent-chat", () => ({
  AgentChat: (props: Record<string, unknown>) => {
    state.chatProps.push(props)
    return <div data-testid="chat" />
  },
}))

import { ConversationPanel, ConversationPanelProvider } from "@/components/panels/conversation-panel"

const CID = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"
const MID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"

beforeEach(() => {
  state.chatProps = []
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ messages: [], conversations: [] })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount() {
  return render(
    <ConversationPanelProvider workspaceId="ws" userId="u" userInitials="U" orgSlug="acme" workspaceSlug="core">
      <ConversationPanel conversationId={CID} />
    </ConversationPanelProvider>,
  )
}
const lastFocus = () => state.chatProps.at(-1)?.focusMessageId

describe("ConversationPanel focus plumbing", () => {
  it("passes a valid ?comment id to the chat", async () => {
    state.search = `?detail=conversation:${CID}&comment=${MID}`
    mount()
    await waitFor(() => expect(lastFocus()).toBe(MID))
  })

  it("passes nothing for a missing or malformed id", async () => {
    state.search = `?detail=conversation:${CID}&comment=%3Cscript%3E`
    mount()
    await waitFor(() => expect(state.chatProps.length).toBeGreaterThan(0))
    expect(lastFocus()).toBeUndefined()
  })

  it("mounts the deep-link opener inside the provider (a bare ?comment= is picked up without any page change)", async () => {
    state.search = `?comment=${MID}`
    mount()
    await waitFor(() => expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).includes("/conversations/locate"))).toBe(true))
  })
})
