// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let mockPathname = "/acme/compass/roadmap"
let mockSearch = ""
const mockReplace = vi.fn()
const mockRefresh = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh }),
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}))

import { AgentChat } from "@/components/agent/agent-chat"
import { EmptyRailSuggestions } from "@/components/agent/empty-rail-suggestions"
import { resetClientPageSuggestionsCache } from "@/components/agent/use-page-suggestions"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function sseResponse(frames: Array<{ event: string; data: unknown }>): Response {
  const encoded = new TextEncoder().encode(
    frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join(""),
  )
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded)
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

beforeEach(() => {
  mockPathname = "/acme/compass/roadmap"
  mockSearch = ""
  resetClientPageSuggestionsCache()
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("EmptyRailSuggestions — debounce, cache, draft freeze, and actions", () => {
  it("debounces 400ms across rapid route hops and aborts in-flight requests on navigation", async () => {
    vi.useFakeTimers()
    const abortedUrls: string[] = []
    const fetchSpy = vi.fn((url: string | URL, init?: RequestInit) => {
      const urlStr = String(url)
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortedUrls.push(urlStr)
          reject(new DOMException("Aborted", "AbortError"))
        })
        if (urlStr.includes("discovery")) {
          setTimeout(() => {
            resolve(
              jsonResponse({
                label: "Discovery",
                pageUrl: "/acme/compass/discovery",
                revisionKey: "rev-disc-1",
                mode: "reading",
                suggestions: [
                  "Which EXPLORING opportunities lack recent customer interviews?",
                  "Compare onboarding friction signals across enterprise segments",
                  "What evidence supports our top discovery bet this quarter?",
                ],
              }),
            )
          }, 200)
        }
      })
    })
    vi.stubGlobal("fetch", fetchSpy)

    const onFire = vi.fn()
    const onEdit = vi.fn()
    const { rerender } = render(
      <EmptyRailSuggestions
        workspaceId="ws-1"
        enabled
        hasDraft={false}
        onFire={onFire}
        onEdit={onEdit}
      />,
    )

    // Hop 1 after 200ms (< 400ms settle): roadmap never fetches
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(fetchSpy).not.toHaveBeenCalled()

    mockPathname = "/acme/compass/okrs"
    rerender(
      <EmptyRailSuggestions
        workspaceId="ws-1"
        enabled
        hasDraft={false}
        onFire={onFire}
        onEdit={onEdit}
      />,
    )

    // Let okrs settle past 400ms so its fetch starts, then navigate to discovery mid-flight!
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain(encodeURIComponent("/acme/compass/okrs"))

    mockPathname = "/acme/compass/discovery"
    rerender(
      <EmptyRailSuggestions
        workspaceId="ws-1"
        enabled
        hasDraft={false}
        onFire={onFire}
        onEdit={onEdit}
      />,
    )
    expect(abortedUrls).toHaveLength(1)
    expect(abortedUrls[0]).toContain(encodeURIComponent("/acme/compass/okrs"))

    // Settle 400ms on discovery -> starts discovery fetch; after 150ms loading hairlines show; after 200ms resolves
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId("empty-rail-suggestion-skeleton")).not.toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(screen.getAllByTestId("empty-rail-suggestion-skeleton")).toHaveLength(3)

    await act(async () => {
      vi.advanceTimersByTime(60)
    })
    expect(screen.queryByTestId("empty-rail-suggestion-skeleton")).not.toBeInTheDocument()
    expect(screen.getByText("Discovery")).toBeInTheDocument()
    expect(screen.getAllByTestId("empty-rail-suggestion-fire")).toHaveLength(3)
  })

  it("renders cached screens in 0ms on revisit without skeleton flash and supports 1-click fire & stage-edit", async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
      const urlStr = String(url)
      if (urlStr.includes("roadmap")) {
        return jsonResponse({
          label: "Roadmap",
          pageUrl: "/acme/compass/roadmap",
          revisionKey: "rev-rm-1",
          mode: "reading",
          suggestions: [
            "Which NOW items risk slipping past their November target dates?",
            "How balanced is NOW against our WIP limit of 3 items?",
          ],
        })
      }
      return jsonResponse({
        label: "Tasks",
        pageUrl: "/acme/compass/tasks",
        revisionKey: "rev-tasks-1",
        mode: "reading",
        suggestions: [
          "Which BLOCKED tasks are holding up NOW roadmap items?",
          "Summarize IN_REVIEW tasks waiting longest for sign-off",
        ],
      })
    })
    vi.stubGlobal("fetch", fetchSpy)

    const onFire = vi.fn()
    const onEdit = vi.fn()
    const { rerender } = render(
      <EmptyRailSuggestions
        workspaceId="ws-1"
        enabled
        hasDraft={false}
        onFire={onFire}
        onEdit={onEdit}
      />,
    )

    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(screen.getByText("Roadmap")).toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Switch to Tasks and let it populate
    mockPathname = "/acme/compass/tasks"
    rerender(
      <EmptyRailSuggestions
        workspaceId="ws-1"
        enabled
        hasDraft={false}
        onFire={onFire}
        onEdit={onEdit}
      />,
    )
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(screen.getByText("Tasks")).toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    // Revisit Roadmap: 0ms instant cache hit (no timers advanced, no extra fetch, no skeleton!)
    mockPathname = "/acme/compass/roadmap"
    rerender(
      <EmptyRailSuggestions
        workspaceId="ws-1"
        enabled
        hasDraft={false}
        onFire={onFire}
        onEdit={onEdit}
      />,
    )
    expect(screen.getByText("Roadmap")).toBeInTheDocument()
    expect(screen.queryByTestId("empty-rail-suggestion-skeleton")).not.toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    // Hover edit stages without firing
    const editButtons = screen.getAllByTestId("empty-rail-suggestion-edit")
    fireEvent.click(editButtons[0])
    expect(onEdit).toHaveBeenCalledWith(
      "Which NOW items risk slipping past their November target dates?",
    )
    expect(onFire).not.toHaveBeenCalled()

    // Clicking primary row fires immediately with snapshotted pageUrl
    const fireButtons = screen.getAllByTestId("empty-rail-suggestion-fire")
    fireEvent.click(fireButtons[1])
    expect(onFire).toHaveBeenCalledWith(
      "How balanced is NOW against our WIP limit of 3 items?",
      "/acme/compass/roadmap",
    )
  })

  it("freezes the displayed stack with 'Pinned while typing' while hasDraft is true and reconciles when cleared", async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
      const urlStr = String(url)
      if (urlStr.includes("roadmap")) {
        return jsonResponse({
          label: "Roadmap",
          pageUrl: "/acme/compass/roadmap",
          revisionKey: "rev-rm",
          mode: "reading",
          suggestions: [
            "Which NOW items risk slipping past their November target dates?",
            "How balanced is NOW against our WIP limit of 3 items?",
          ],
        })
      }
      return jsonResponse({
        label: "OKRs",
        pageUrl: "/acme/compass/okrs",
        revisionKey: "rev-okrs",
        mode: "reading",
        suggestions: [
          "Which Q4 Key Results are furthest behind pace right now?",
          "Which Objectives have zero linked discovery opportunities?",
        ],
      })
    })
    vi.stubGlobal("fetch", fetchSpy)

    const onFire = vi.fn()
    const { rerender } = render(
      <EmptyRailSuggestions
        workspaceId="ws-1"
        enabled
        hasDraft={false}
        onFire={onFire}
        onEdit={vi.fn()}
      />,
    )

    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(screen.getByText("Roadmap")).toBeInTheDocument()
    expect(screen.queryByTestId("empty-rail-suggestions-pinned")).not.toBeInTheDocument()

    // User starts typing in composer -> pinnedWhileTyping appears
    rerender(
      <EmptyRailSuggestions
        workspaceId="ws-1"
        enabled
        hasDraft
        onFire={onFire}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByTestId("empty-rail-suggestions-pinned")).toHaveTextContent(
      "Pinned while typing",
    )

    // User navigates behind the rail to /okrs while typing -> prompts stay frozen on Roadmap, no fetch fires!
    mockPathname = "/acme/compass/okrs"
    rerender(
      <EmptyRailSuggestions
        workspaceId="ws-1"
        enabled
        hasDraft
        onFire={onFire}
        onEdit={vi.fn()}
      />,
    )
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.getByText("Roadmap")).toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // If user clicks a pinned row while on /okrs, it still sends Roadmap's snapshotted pageUrl
    fireEvent.click(screen.getAllByTestId("empty-rail-suggestion-fire")[0])
    expect(onFire).toHaveBeenCalledWith(
      "Which NOW items risk slipping past their November target dates?",
      "/acme/compass/roadmap",
    )

    // User clears draft -> reconciles to /okrs after 400ms settle
    rerender(
      <EmptyRailSuggestions
        workspaceId="ws-1"
        enabled
        hasDraft={false}
        onFire={onFire}
        onEdit={vi.fn()}
      />,
    )
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(screen.getByText("OKRs")).toBeInTheDocument()
    expect(screen.queryByTestId("empty-rail-suggestions-pinned")).not.toBeInTheDocument()
  })
})

describe("AgentChat integration — visibility gating and 1-click turn submission", () => {
  function chatProps(overrides: Partial<Parameters<typeof AgentChat>[0]> = {}) {
    return {
      workspaceId: "ws-1",
      basePath: "/acme/compass",
      conversations: [],
      activeConversationId: null,
      initialMessages: [],
      userInitials: "RB",
      userId: "user-1",
      ...overrides,
    }
  }

  it("hides suggestions on page variant, inactive rail view, non-empty threads, or when seedEntity is present", async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
      if (String(url).startsWith("/api/agent/choices")) {
        return jsonResponse({ agents: [], defaultAgentId: null, connectors: [] })
      }
      return jsonResponse({
        label: "Roadmap",
        pageUrl: "/acme/compass/roadmap",
        revisionKey: "rev-1",
        mode: "reading",
        suggestions: [
          "Which NOW items risk slipping past their November target dates?",
          "How balanced is NOW against our WIP limit of 3 items?",
        ],
      })
    })
    vi.stubGlobal("fetch", fetchSpy)

    // 1. variant="page" -> hidden
    const { unmount: u1 } = render(<AgentChat {...chatProps({ variant: "page" })} />)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByTestId("empty-rail-suggestions")).not.toBeInTheDocument()
    u1()

    // 2. railActive={false} (e.g. Help or Library tab active) -> hidden
    const { unmount: u2 } = render(<AgentChat {...chatProps({ variant: "rail", railActive: false })} />)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByTestId("empty-rail-suggestions")).not.toBeInTheDocument()
    u2()

    // 3. existing messages -> hidden
    const { unmount: u3 } = render(
      <AgentChat
        {...chatProps({
          variant: "rail",
          activeConversationId: "conv-1",
          initialMessages: [{ id: "m-1", role: "user", content: "Hello" }],
        })}
      />,
    )
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByTestId("empty-rail-suggestions")).not.toBeInTheDocument()
    u3()

    // 4. pendingSeedEntity present -> hidden
    const { unmount: u4 } = render(
      <AgentChat
        {...chatProps({
          variant: "rail",
          seedEntity: {
            entityType: "solutionPlan",
            entityId: "plan-1",
            label: "Plan",
            summary: "Summary",
            sourceUrl: "/acme/compass/solutions",
          },
        })}
      />,
    )
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByTestId("empty-rail-suggestions")).not.toBeInTheDocument()
    u4()
  })

  it("stages via ✎ into the composer and 1-click fires /api/agent/turn with snapshotted pageUrl", async () => {
    vi.useFakeTimers()
    mockPathname = "/acme/compass/docs/doc-123"

    const turnBodies: Array<Record<string, unknown>> = []
    const fetchSpy = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.startsWith("/api/agent/choices")) {
        return jsonResponse({ agents: [], defaultAgentId: null, connectors: [] })
      }
      if (urlStr.startsWith("/api/agent/page-suggestions")) {
        return jsonResponse({
          label: "Q4 Discovery Synthesis",
          pageUrl: "/acme/compass/docs/doc-123",
          revisionKey: "rev-doc-123",
          mode: "reading",
          suggestions: [
            "Which Q4 OKRs lack supporting evidence in Q4 Discovery Synthesis?",
            "What untested high-risk assumptions block the onboarding redesign?",
          ],
        })
      }
      if (urlStr === "/api/agent/turn") {
        turnBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
        return sseResponse([
          { event: "status", data: { phase: "running", conversationId: "conv-new" } },
          { event: "result", data: { text: "Here is the gap analysis.", conversationId: "conv-new" } },
        ])
      }
      return jsonResponse({})
    })
    vi.stubGlobal("fetch", fetchSpy)

    render(<AgentChat {...chatProps({ variant: "rail", railActive: true })} />)

    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(screen.getByText("Q4 Discovery Synthesis")).toBeInTheDocument()

    // Click ✎ edit button -> populates textarea without calling /api/agent/turn
    fireEvent.click(screen.getAllByTestId("empty-rail-suggestion-edit")[0])
    const textarea = screen.getByRole("textbox", { name: "Message the agent" }) as HTMLTextAreaElement
    expect(textarea.value).toBe("Which Q4 OKRs lack supporting evidence in Q4 Discovery Synthesis?")
    expect(turnBodies).toHaveLength(0)

    // Clear composer, then click row 2 to 1-click fire!
    fireEvent.change(textarea, { target: { value: "" } })
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("empty-rail-suggestion-fire")[1])
    })

    expect(turnBodies).toHaveLength(1)
    expect(turnBodies[0].message).toBe(
      "What untested high-risk assumptions block the onboarding redesign?",
    )
    expect(turnBodies[0].pageUrl).toBe("/acme/compass/docs/doc-123")
    // Once turn starts and messages populate, the empty-rail suggestion stack disappears
    expect(screen.queryByTestId("empty-rail-suggestions")).not.toBeInTheDocument()
  })
})
