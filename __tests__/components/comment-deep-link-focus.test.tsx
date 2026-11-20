// @vitest-environment jsdom
// Unit tests do not run Next's Server Action transform; keep its server dependencies outside this client boundary.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/links/conversation-actions", () => ({ removeObjectConversationLink: vi.fn() }))
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const searchParamsState = vi.hoisted(() => ({ comment: null as string | null }))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(searchParamsState.comment ? { comment: searchParamsState.comment } : {}),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/rbcodelabs/compass/discovery/OPP-7",
}))

import { Discussion } from "@/components/comments/discussion"
import { DocCommentsSidebar } from "@/components/docs/doc-comments-sidebar"

describe("deep-link comment focus (?comment=<id>)", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    searchParamsState.comment = null
  })

  afterEach(() => {
    cleanup()
    global.fetch = originalFetch
    vi.clearAllMocks()
  })

  it("expands a resolved Discussion root thread and highlights the targeted reply when ?comment=<replyId> is set", async () => {
    searchParamsState.comment = "reply-1"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "root-resolved",
            parentId: null,
            body: "Initial question on OPP-7",
            status: "RESOLVED",
            authorName: "Rick",
            authorType: "HUMAN",
            createdAt: "2026-11-15T16:17:31.873Z",
            edited: false,
            canEdit: true,
            canDelete: false,
            canModerate: true,
            replies: [
              {
                id: "reply-1",
                parentId: "root-resolved",
                body: "Agent synthesis reply inside resolved thread",
                status: "OPEN",
                authorName: "Geode MacBook Air",
                authorType: "AGENT",
                createdAt: "2026-11-15T21:25:13.961Z",
                edited: false,
                canEdit: false,
                canDelete: false,
                canModerate: false,
                replies: [],
              },
            ],
          },
        ],
        mention: { options: { people: [], agents: [], outside: [] }, confirmedAgentIds: [], targetTitle: "OPP-7" },
        taskCards: {},
      }),
    }) as unknown as typeof fetch

    render(<Discussion targetType="OPPORTUNITY" targetId="opp-7" />)

    // Even though root-resolved is RESOLVED (which collapses by default), targeting reply-1 expands it automatically.
    await screen.findByText("Agent synthesis reply inside resolved thread")
    const focusedArticle = document.getElementById("comment-reply-1")
    expect(focusedArticle).not.toBeNull()
    expect(focusedArticle).toHaveAttribute("data-comment-focused", "true")
  })

  it("reveals resolved Doc comment threads and marks the focused comment in DocCommentsSidebar", async () => {
    render(
      <DocCommentsSidebar
        open
        onOpenChange={vi.fn()}
        comments={[
          {
            id: "doc-cmt-resolved",
            parentId: null,
            body: "Resolved rollout note",
            status: "RESOLVED",
            anchorText: "REVIEW",
            anchorStart: 0,
            anchorEnd: 6,
            anchorPrefix: "",
            anchorSuffix: " rollout",
            authorName: "Rick",
            authorType: "HUMAN",
            createdAt: new Date("2026-11-15T16:00:00Z"),
          },
        ]}
        orphanedIds={new Set()}
        onAddReply={vi.fn()}
        onResolve={vi.fn()}
        onDelete={vi.fn()}
        onFocusComment={vi.fn()}
        focusedCommentId="doc-cmt-resolved"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText("Resolved rollout note")).toBeInTheDocument()
    })
    const thread = document.getElementById("comment-doc-cmt-resolved")
    expect(thread).not.toBeNull()
    expect(thread).toHaveAttribute("data-comment-focused", "true")
  })
})
