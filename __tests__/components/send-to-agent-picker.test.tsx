// @vitest-environment jsdom
//
// "Send to agent" runtime picker (components/agent/send-to-agent-picker.tsx).
// Bridge-absent rendering must be byte-for-byte identical to the plain
// <Link> the two call sites (solution-plan-discussion.tsx,
// reviews/[requestId]/page.tsx) rendered before this component existed — see
// __tests__/components/solution-plan-discussion.test.tsx and
// __tests__/review-request-page.test.tsx, which assert those hrefs directly
// and must keep passing unmodified.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SendToAgentPicker } from "@/components/agent/send-to-agent-picker"

const HANDOFF_RESPONSE = {
  entityType: "solutionPlan",
  entityId: "plan-1",
  orgSlug: "acme",
  workspaceSlug: "product",
  label: "Approved plan · Redesigned onboarding",
  summary: "Ship a redesigned onboarding flow.",
  suggestedInstruction: "Help me move forward with the approved plan.",
  promptBlock: "Approved Solution Plan for \"Redesigned onboarding\":\n\n...",
  sourceUrl: "/acme/product/discovery/opp-1?detail=solution:sol-1",
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response
}

afterEach(() => {
  cleanup()
  delete (window as { __geode?: unknown }).__geode
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("SendToAgentPicker — bridge absent (default)", () => {
  it("renders a real link with an icon+text child, matching today's outline-button call site", () => {
    render(
      <SendToAgentPicker
        orgSlug="acme"
        workspaceSlug="product"
        entityType="solutionPlan"
        entityId="plan-1"
        className="btn-outline"
      >
        <span data-testid="icon" />
        Send to agent
      </SendToAgentPicker>
    )
    const link = screen.getByRole("link", { name: /send to agent/i })
    expect(link).toHaveAttribute("href", "/acme/product/agent?entityType=solutionPlan&entityId=plan-1")
    expect(link).toHaveClass("btn-outline")
    expect(screen.getByTestId("icon")).toBeInTheDocument()
  })

  it("renders a real link with plain-text children, matching today's underlined-text call site", () => {
    render(
      <SendToAgentPicker
        orgSlug="acme"
        workspaceSlug="product"
        entityType="decision"
        entityId="request-1"
        className="inline-block font-medium text-primary underline"
      >
        Send to agent
      </SendToAgentPicker>
    )
    const link = screen.getByRole("link", { name: /send to agent/i })
    expect(link).toHaveAttribute("href", "/acme/product/agent?entityType=decision&entityId=request-1")
    expect(link).toHaveClass("inline-block", "font-medium", "text-primary", "underline")
  })

  it("does not render a menu when the bridge is absent", () => {
    render(
      <SendToAgentPicker orgSlug="acme" workspaceSlug="product" entityType="solutionPlan" entityId="plan-1">
        Send to agent
      </SendToAgentPicker>
    )
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.queryByText("Geode")).toBeNull()
  })
})

describe("SendToAgentPicker — bridge present", () => {
  beforeEach(() => {
    ;(window as unknown as { __geode: { postEvent: ReturnType<typeof vi.fn> } }).__geode = {
      postEvent: vi.fn(),
    }
  })

  function openMenu() {
    const trigger = screen.getByRole("button", { name: /send to agent/i })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    return trigger
  }

  it("renders both menu options instead of a plain link", async () => {
    render(
      <SendToAgentPicker orgSlug="acme" workspaceSlug="product" entityType="solutionPlan" entityId="plan-1">
        Send to agent
      </SendToAgentPicker>
    )
    openMenu()
    expect(await screen.findByRole("menuitem", { name: /built-in cloud agent/i })).toBeInTheDocument()
    expect(await screen.findByRole("menuitem", { name: "Geode" })).toBeInTheDocument()
  })

  it("\"Built-in cloud agent\" is still a real link to the built-in hand-off route — no fetch, no postEvent", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    render(
      <SendToAgentPicker orgSlug="acme" workspaceSlug="product" entityType="solutionPlan" entityId="plan-1">
        Send to agent
      </SendToAgentPicker>
    )
    openMenu()
    // The menuitem is a wrapper (established pattern: components/mobile-header.tsx
    // nests a real <Link> inside a DropdownMenuItem for items that navigate);
    // the href lives on the nested <a>, not the wrapper.
    const builtIn = await screen.findByRole("link", { name: /built-in cloud agent/i })
    expect(builtIn).toHaveAttribute("href", "/acme/product/agent?entityType=solutionPlan&entityId=plan-1")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(window.__geode?.postEvent).not.toHaveBeenCalled()
  })

  it("\"Geode\" fetches hand-off context and posts the bridge event exactly once with an absolute url", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(HANDOFF_RESPONSE))
    vi.stubGlobal("fetch", fetchMock)
    render(
      <SendToAgentPicker orgSlug="acme" workspaceSlug="product" entityType="solutionPlan" entityId="plan-1">
        Send to agent
      </SendToAgentPicker>
    )
    openMenu()
    const geodeItem = await screen.findByRole("menuitem", { name: "Geode" })
    await act(async () => {
      fireEvent.click(geodeItem)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const requestedUrl = fetchMock.mock.calls[0][0] as string
    expect(requestedUrl).toContain("/api/agent/handoff-context?")
    expect(requestedUrl).toContain("entityType=solutionPlan")
    expect(requestedUrl).toContain("entityId=plan-1")
    expect(requestedUrl).toContain("orgSlug=acme")
    expect(requestedUrl).toContain("workspaceSlug=product")

    const postEvent = window.__geode?.postEvent as ReturnType<typeof vi.fn>
    expect(postEvent).toHaveBeenCalledTimes(1)
    expect(postEvent).toHaveBeenCalledWith("agent.handoff", {
      entityType: "solutionPlan",
      entityId: "plan-1",
      orgSlug: "acme",
      workspaceSlug: "product",
      label: HANDOFF_RESPONSE.label,
      summary: HANDOFF_RESPONSE.summary,
      suggestedInstruction: HANDOFF_RESPONSE.suggestedInstruction,
      promptBlock: HANDOFF_RESPONSE.promptBlock,
      url: `${window.location.origin}${HANDOFF_RESPONSE.sourceUrl}`,
    })
  })

  it("does not call postEvent when the hand-off context fetch rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"))
    vi.stubGlobal("fetch", fetchMock)
    render(
      <SendToAgentPicker orgSlug="acme" workspaceSlug="product" entityType="solutionPlan" entityId="plan-1">
        Send to agent
      </SendToAgentPicker>
    )
    openMenu()
    const geodeItem = await screen.findByRole("menuitem", { name: "Geode" })
    await act(async () => {
      fireEvent.click(geodeItem)
    })

    const postEvent = window.__geode?.postEvent as ReturnType<typeof vi.fn>
    expect(postEvent).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it("does not call postEvent when the hand-off context request returns a non-2xx status", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, false, 404))
    vi.stubGlobal("fetch", fetchMock)
    render(
      <SendToAgentPicker orgSlug="acme" workspaceSlug="product" entityType="solutionPlan" entityId="plan-1">
        Send to agent
      </SendToAgentPicker>
    )
    openMenu()
    const geodeItem = await screen.findByRole("menuitem", { name: "Geode" })
    await act(async () => {
      fireEvent.click(geodeItem)
    })

    const postEvent = window.__geode?.postEvent as ReturnType<typeof vi.fn>
    expect(postEvent).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })
})
