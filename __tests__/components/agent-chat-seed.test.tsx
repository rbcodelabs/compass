// @vitest-environment jsdom
//
// "Send to agent" hand-off behavior in AgentChat (components/agent/agent-chat.tsx):
// composer seeding, the dismissible context chip, and including/clearing
// `seedContext` on the POST body for exactly the first turn of a brand-new
// conversation. See lib/agent-context.ts and app/api/agent/turn/route.ts for
// the server-side half of this contract.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockReplace = vi.fn()
const mockRefresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mockReplace, refresh: mockRefresh }) }))

import { AgentChat } from "@/components/agent/agent-chat"

const SEED_ENTITY = {
  entityType: "solutionPlan",
  entityId: "plan-1",
  label: "Approved plan · Redesigned onboarding",
  summary: "Ship a redesigned onboarding flow.",
  sourceUrl: "/acme/product/discovery/opp-1?detail=solution:sol-1",
}
const SUGGESTED_INSTRUCTION = "Help me move forward with the approved plan."

function sseResponse(frames: { event: string; data: unknown }[]) {
  const encoder = new TextEncoder()
  const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join("")
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

function baseProps(overrides: Partial<Parameters<typeof AgentChat>[0]> = {}) {
  return {
    workspaceId: "ws-1",
    basePath: "/acme/product",
    conversations: [],
    activeConversationId: null,
    initialMessages: [],
    userInitials: "RB",
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("AgentChat — seed context hand-off", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it("prefills the composer from suggestedInstruction on a brand-new chat", () => {
    render(<AgentChat {...baseProps({ seedEntity: SEED_ENTITY, suggestedInstruction: SUGGESTED_INSTRUCTION })} />)
    const textarea = screen.getByPlaceholderText(/message the agent/i) as HTMLTextAreaElement
    expect(textarea.value).toBe(SUGGESTED_INSTRUCTION)
  })

  it("does not prefill the composer when resuming an existing conversation", () => {
    render(
      <AgentChat
        {...baseProps({
          activeConversationId: "c-1",
          initialMessages: [{ id: "m-1", role: "user", content: "hi" }],
          seedEntity: SEED_ENTITY,
          suggestedInstruction: SUGGESTED_INSTRUCTION,
        })}
      />
    )
    const textarea = screen.getByPlaceholderText(/message the agent/i) as HTMLTextAreaElement
    expect(textarea.value).toBe("")
  })

  it("renders the context chip and dismissing it clears only the chip, not the composer text", () => {
    render(<AgentChat {...baseProps({ seedEntity: SEED_ENTITY, suggestedInstruction: SUGGESTED_INSTRUCTION })} />)
    expect(screen.getByText(SEED_ENTITY.label)).toBeInTheDocument()

    const textarea = screen.getByPlaceholderText(/message the agent/i) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "Edited instruction" } })

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(screen.queryByText(SEED_ENTITY.label)).toBeNull()
    expect(textarea.value).toBe("Edited instruction")
  })

  it("includes seedContext on the first turn's POST body, then omits it on the next turn", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          { event: "status", data: { phase: "running", conversationId: "c-new" } },
          { event: "result", data: { text: "First reply", conversationId: "c-new" } },
        ])
      )
      .mockResolvedValueOnce(
        sseResponse([
          { event: "status", data: { phase: "running", conversationId: "c-new" } },
          { event: "result", data: { text: "Second reply", conversationId: "c-new" } },
        ])
      )
    vi.stubGlobal("fetch", fetchMock)

    render(<AgentChat {...baseProps({ seedEntity: SEED_ENTITY, suggestedInstruction: SUGGESTED_INSTRUCTION })} />)

    const sendButton = screen.getByRole("button", { name: "Send message" })
    await act(async () => {
      fireEvent.click(sendButton)
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(firstBody.seedContext).toEqual({ entityType: "solutionPlan", entityId: "plan-1" })

    // Chip clears immediately once the seeded turn is sent.
    expect(screen.queryByText(SEED_ENTITY.label)).toBeNull()

    const textarea = screen.getByPlaceholderText(/message the agent/i) as HTMLTextAreaElement
    await waitFor(() => expect(textarea).not.toBeDisabled())
    fireEvent.change(textarea, { target: { value: "A follow-up question" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(secondBody.seedContext).toBeUndefined()

    vi.unstubAllGlobals()
  })
})
