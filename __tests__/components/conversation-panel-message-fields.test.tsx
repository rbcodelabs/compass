// @vitest-environment jsdom
//
// TASK-195 S1: the Conversation panel loads /messages itself and hands the rows to AgentChat. Its parser used to keep
// only id/role/content/createdAt/author, so the FIRST render never showed Edit or Edited. This drives the real panel,
// the real provider and the real parser, with the real DTO shape from the route.
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ value: { replace: () => {}, refresh: () => {}, push: () => {} } }))
const params = vi.hoisted(() => ({ value: new URLSearchParams() }))
vi.mock("next/navigation", () => ({
  useRouter: () => router.value,
  usePathname: () => "/acme/product/discovery",
  useSearchParams: () => params.value,
}))
// Stable identities: the provider's effects depend on `panel` and `openPanel`, so fresh objects per call would loop.
const panelContext = vi.hoisted(() => ({
  value: { panel: { type: "conversation", id: "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312" }, openPanel: () => {}, closePanel: () => {} },
}))
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => panelContext.value }))

import { ConversationPanel, ConversationPanelProvider } from "@/components/panels/conversation-panel"

const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"

const DTO = {
  messages: [
    { id: "m-mine", role: "user", content: "my words", createdAt: "2026-11-19T09:00:00.000Z", authorUserId: "user-1", authorName: "Rick", editedAt: "2026-11-19T10:00:00.000Z", authorType: "HUMAN", messageKind: "COMMENT", canEdit: true, canDelete: false },
    { id: "m-other", role: "user", content: "their words", createdAt: "2026-11-19T09:05:00.000Z", authorUserId: "user-2", authorName: "Lee", editedAt: null, authorType: "HUMAN", messageKind: "COMMENT", canEdit: false, canDelete: false },
  ],
  taskCards: {},
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes(`/conversations/${CONV}/messages`)) return Response.json(DTO)
      if (u.includes(`/conversations/${CONV}/settings`)) return Response.json({ agentMode: "MENTION_ONLY", visibility: "WORKSPACE", status: "OPEN", targetType: null, targetId: null, targetLabel: null })
      if (u.includes("/api/agent/conversations?")) return Response.json({ conversations: [] })
      return new Response("{}", { status: 200 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ConversationPanel first render of /messages rows", () => {
  it("shows Edit for a message the server marked canEdit, the Edited marker for an edited one, and nothing for others", async () => {
    render(
      <ConversationPanelProvider workspaceId="ws-1" userId="user-1" userInitials="RB" orgSlug="acme" workspaceSlug="product">
        <ConversationPanel conversationId={CONV} />
      </ConversationPanelProvider>,
    )
    const rows = await screen.findAllByTestId("conversation-message")
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector('[data-testid="message-edit-button"]')).not.toBeNull()
    expect(rows[0]!.querySelector('[data-testid="message-edited-marker"]')).not.toBeNull()
    expect(rows[1]!.querySelector('[data-testid="message-edit-button"]')).toBeNull()
    expect(rows[1]!.querySelector('[data-testid="message-edited-marker"]')).toBeNull()
  })
})
