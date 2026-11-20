// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const captured = vi.hoisted(() => ({ excluded: [] as unknown[], onBodyChange: null as null | ((body: string) => void) }))
vi.mock("@/components/panels/conversation-panel", () => ({
  useConversationPanelOptional: () => ({ workspaceId: "workspace", orgSlug: "acme", workspaceSlug: "core", openConversationInPanel: vi.fn(), startNewConversationInPanel: vi.fn() }),
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/links/conversation-actions", () => ({ removeObjectConversationLink: vi.fn() }))
vi.mock("@/components/docs/doc-comment-composer", () => ({
  DocCommentComposer: (props: { excludedAssigneeIds?: unknown; onBodyChange?: (body: string) => void }) => {
    captured.excluded.push(props.excludedAssigneeIds)
    captured.onBodyChange = props.onBodyChange ?? null
    return <div data-testid="composer" />
  },
}))
import { ObjectConversationsSection } from "@/components/conversations/object-conversations-section"

beforeEach(() => {
  captured.excluded = []
  captured.onBodyChange = null
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [] })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ObjectConversationsSection composer props", () => {
  it("passes the same excludedAssigneeIds array on every render, so the composer's memo is not recomputed per keystroke", async () => {
    render(<ObjectConversationsSection targetType="TASK" targetId="task" />)
    await screen.findByTestId("composer")
    act(() => captured.onBodyChange?.("a"))
    act(() => captured.onBodyChange?.("ab"))
    expect(captured.excluded.length).toBeGreaterThanOrEqual(3)
    expect(Array.isArray(captured.excluded[0])).toBe(true)
    expect(new Set(captured.excluded).size).toBe(1)
  })
})
