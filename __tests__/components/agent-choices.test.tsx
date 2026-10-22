// @vitest-environment jsdom
//
// Agent selection in the chat composer and the Send to agent menu (phase 3 of "Cloud agents as first-class identities").
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))

import { AgentChat } from "@/components/agent/agent-chat"
import { SendToAgentPicker } from "@/components/agent/send-to-agent-picker"
import { choose, chipButton, chipValue, optionNames, queryChipButton, findChipButton } from "./composer-chips"

const CHOICES = { agents: [{ id: "a-shared", name: "Triage", shared: true }, { id: "a-mine", name: "Mine", shared: false }], defaultAgentId: "a-shared" }

function sse() {
  const text = `event: status\ndata: ${JSON.stringify({ phase: "running", conversationId: "c-1" })}\n\nevent: result\ndata: ${JSON.stringify({ text: "ok", conversationId: "c-1" })}\n\n`
  return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() } }), { status: 200 })
}

/** Answers the choices lookup with `choices` and records every other request. */
function stubFetch(choices: unknown, options: { status?: number } = {}) {
  const turns = vi.fn().mockImplementation(async () => sse())
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    String(url).startsWith("/api/agent/choices")
      ? Promise.resolve({ ok: (options.status ?? 200) < 400, status: options.status ?? 200, json: async () => choices })
      : turns(url, init),
  )
  return turns
}
const chatProps = (overrides: Partial<Parameters<typeof AgentChat>[0]> = {}) => ({ workspaceId: "ws-1", basePath: "/acme/product", conversations: [], activeConversationId: null, initialMessages: [], userInitials: "RB", userId: "u1", ...overrides })

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as { __geode?: unknown }).__geode })

async function send(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/message the agent/i), { target: { value: text } })
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send message" })) })
}

describe("AgentChat agent selector", () => {
  it("is absent when the member has no cloud agents to pick", async () => {
    stubFetch({ agents: [], defaultAgentId: null })
    render(<AgentChat {...chatProps()} />)
    await act(async () => {})
    expect(queryChipButton("Agent")).toBeNull()
  })

  it("is absent when the lookup fails (the chat behaves as before)", async () => {
    stubFetch({}, { status: 500 })
    render(<AgentChat {...chatProps()} />)
    await act(async () => {})
    expect(queryChipButton("Agent")).toBeNull()
  })

  it("defaults to the resolved default and sends no agentId, leaving the choice to the server", async () => {
    const turns = stubFetch(CHOICES)
    render(<AgentChat {...chatProps()} />)
    await findChipButton("Agent")
    expect(chipValue("Agent")).toBe("Default (Triage)")
    expect(await optionNames("Agent")).toEqual(["Default (Triage)", "Compass Agent", "Triage (shared)", "Mine"])
    await send("hello")
    await waitFor(() => expect(turns).toHaveBeenCalled())
    expect(JSON.parse(turns.mock.calls[0][1].body)).not.toHaveProperty("agentId")
  })

  it("sends the chosen agent's id", async () => {
    const turns = stubFetch(CHOICES)
    render(<AgentChat {...chatProps()} />)
    await findChipButton("Agent")
    await choose("Agent", "Mine")
    await send("hello")
    await waitFor(() => expect(turns).toHaveBeenCalled())
    expect(JSON.parse(turns.mock.calls[0][1].body).agentId).toBe("a-mine")
  })

  it('sends "builtin" when the built-in agent is chosen on purpose', async () => {
    const turns = stubFetch(CHOICES)
    render(<AgentChat {...chatProps()} />)
    await findChipButton("Agent")
    await choose("Agent", "Compass Agent")
    await send("hello")
    await waitFor(() => expect(turns).toHaveBeenCalled())
    expect(JSON.parse(turns.mock.calls[0][1].body).agentId).toBe("builtin")
  })

  it("starts with the agent from ?agentId when the member can pick it, and ignores one they cannot", async () => {
    stubFetch(CHOICES)
    render(<AgentChat {...chatProps({ initialAgentId: "a-mine" })} />)
    await waitFor(() => expect(chipValue("Agent")).toBe("Mine"))
    cleanup()
    stubFetch(CHOICES)
    render(<AgentChat {...chatProps({ initialAgentId: "someone-elses" })} />)
    await waitFor(() => expect(chipValue("Agent")).toBe("Default (Triage)"))
  })
})

describe("AgentChat composer layout", () => {
  it("has no context strip until there is a status or a chip to show, and no footer without choices", async () => {
    stubFetch({ agents: [], defaultAgentId: null })
    const { container } = render(<AgentChat {...chatProps()} />)
    await act(async () => {})
    expect(container.querySelector('[data-slot="composer-strip"]')).toBeNull()
    expect(container.querySelector('[data-slot="composer-footer"]')).toBeNull()
  })

  it("shows the Agent chip in the footer once there are agents to pick", async () => {
    stubFetch(CHOICES)
    const { container } = render(<AgentChat {...chatProps()} />)
    await findChipButton("Agent")
    expect(container.querySelector('[data-slot="composer-footer"]')).toContainElement(chipButton("Agent"))
    expect(container.querySelector('[data-slot="composer-strip"]')).toBeNull()
  })
})

describe("AgentChat in the rail", () => {
  it("renders the same composer, with its chips, in the rail variant", async () => {
    stubFetch(CHOICES)
    const { container } = render(<AgentChat {...chatProps({ variant: "rail" })} />)
    await findChipButton("Agent")
    expect(container.querySelector('[data-slot="composer-card"]')).toContainElement(chipButton("Agent"))
    expect(screen.getByRole("textbox", { name: "Message the agent" })).toBeInTheDocument()
    await choose("Agent", "Mine")
    expect(chipValue("Agent")).toBe("Mine")
  })
})

describe("SendToAgentPicker with cloud agents", () => {
  const picker = () => (
    <SendToAgentPicker orgSlug="acme" workspaceSlug="product" entityType="solutionPlan" entityId="plan-1">Send to agent</SendToAgentPicker>
  )

  it("stays the plain link when there are no cloud agents", async () => {
    stubFetch({ agents: [], defaultAgentId: null })
    render(picker())
    await act(async () => {})
    expect(screen.getByRole("link", { name: /send to agent/i })).toHaveAttribute("href", "/acme/product/agent?entityType=solutionPlan&entityId=plan-1")
  })

  it("becomes a menu naming the default first and offering every other agent and the built-in one", async () => {
    stubFetch(CHOICES)
    render(picker())
    fireEvent.click(await screen.findByRole("button", { name: /send to agent/i }))
    const defaultLink = await screen.findByRole("link", { name: "Triage (default)" })
    expect(defaultLink).toHaveAttribute("href", "/acme/product/agent?entityType=solutionPlan&entityId=plan-1")
    expect(screen.getByRole("link", { name: "Mine" })).toHaveAttribute("href", "/acme/product/agent?entityType=solutionPlan&entityId=plan-1&agentId=a-mine")
    expect(screen.getByRole("link", { name: "Built-in cloud agent" })).toHaveAttribute("href", "/acme/product/agent?entityType=solutionPlan&entityId=plan-1&agentId=builtin")
    expect(screen.queryByText("Geode")).toBeNull()
  })

  it("keeps Built-in cloud agent as the first plain link when agents exist but none is the default", async () => {
    stubFetch({ ...CHOICES, defaultAgentId: null })
    render(picker())
    fireEvent.click(await screen.findByRole("button", { name: /send to agent/i }))
    expect(await screen.findByRole("link", { name: "Built-in cloud agent" })).toHaveAttribute("href", "/acme/product/agent?entityType=solutionPlan&entityId=plan-1")
    expect(screen.getByRole("link", { name: "Triage" })).toBeInTheDocument()
  })
})
