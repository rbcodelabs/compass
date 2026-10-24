// @vitest-environment jsdom
//
// The model picker in the chat composer: what it offers, what "Default" resolves to, what a turn carries, and what is remembered.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))

import { AgentChat } from "@/components/agent/agent-chat"
import { defaultModelFor, modelPickStorageKey } from "@/components/agent/model-picker"
import type { AgentChoices } from "@/components/agent/use-agent-choices"
import { choose, chipButton, chipValue, findChipButton, optionNames, queryChipButton } from "./composer-chips"

const MODELS = [
  { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { value: "claude-opus-9", label: "Claude Opus 9" },
]
const CHOICES: AgentChoices = {
  agents: [
    { id: "a-shared", name: "Triage", shared: true, model: "claude-opus-9" },
    { id: "a-mine", name: "Mine", shared: false, model: null },
  ],
  defaultAgentId: "a-shared",
  connectors: [],
  models: MODELS,
  deploymentModel: "claude-sonnet-5",
  modelLabels: { "claude-sonnet-5": "Claude Sonnet 5", "claude-opus-9": "Claude Opus 9" },
  loaded: true,
}
const wire = (choices: Partial<AgentChoices>) => ({ ...CHOICES, ...choices, loaded: undefined })

function sse() {
  const text = `event: status\ndata: ${JSON.stringify({ phase: "running", conversationId: "c-1" })}\n\nevent: result\ndata: ${JSON.stringify({ text: "ok", conversationId: "c-1" })}\n\n`
  return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() } }), { status: 200 })
}

function stubFetch(choices: unknown, extra: (url: string) => Response | undefined = () => undefined) {
  const turns = vi.fn().mockImplementation(async () => sse())
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const special = extra(String(url))
    if (special) return Promise.resolve(special)
    return String(url).startsWith("/api/agent/choices")
      ? Promise.resolve({ ok: true, status: 200, json: async () => choices })
      : turns(url, init)
  })
  return turns
}
const chatProps = (overrides: Partial<Parameters<typeof AgentChat>[0]> = {}) => ({ workspaceId: "ws-1", basePath: "/acme/product", conversations: [], activeConversationId: null, initialMessages: [], userInitials: "RB", userId: "u1", ...overrides })
const KEY = modelPickStorageKey("u1", "ws-1")

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); window.localStorage.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as { __geode?: unknown }).__geode })

async function send(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/message the agent/i), { target: { value: text } })
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send message" })) })
}

describe("defaultModelFor", () => {
  it("resolves to the selected agent's model, else the deployment default", () => {
    expect(defaultModelFor(CHOICES, "")).toBe("claude-opus-9") // the resolved default agent
    expect(defaultModelFor(CHOICES, "a-mine")).toBe("claude-sonnet-5") // an agent with no model of its own
    expect(defaultModelFor(CHOICES, "builtin")).toBe("claude-sonnet-5")
    expect(defaultModelFor({ ...CHOICES, defaultAgentId: null }, "")).toBe("claude-sonnet-5")
  })
})

describe("AgentChat model picker", () => {
  it("is absent when the deployment offers no model choice (e.g. Bedrock)", async () => {
    stubFetch(wire({ models: [] }))
    render(<AgentChat {...chatProps()} />)
    await findChipButton("Agent")
    expect(queryChipButton("Model")).toBeNull()
  })

  it("is absent when the only model on offer is what Default already gives (nothing to choose)", async () => {
    stubFetch(wire({ agents: [], defaultAgentId: null, models: [MODELS[0]] }))
    render(<AgentChat {...chatProps()} />)
    await act(async () => {})
    expect(queryChipButton("Model")).toBeNull()
  })

  it("appears for the built-in assistant alone (no cloud agents) when there are models to choose from", async () => {
    stubFetch(wire({ agents: [], defaultAgentId: null }))
    render(<AgentChat {...chatProps()} />)
    expect(await findChipButton("Model")).toBeInTheDocument()
    expect(queryChipButton("Agent")).toBeNull()
    expect(await optionNames("Model")).toEqual(["Default (Claude Sonnet 5)", "Claude Sonnet 5", "Claude Opus 9"])
  })

  it("shows the effective model in the Default option, and follows the agent until the user picks one", async () => {
    stubFetch(CHOICES)
    render(<AgentChat {...chatProps()} />)
    await findChipButton("Model")
    expect(chipValue("Model")).toBe("Default (Claude Opus 9)")
    expect(await optionNames("Model")).toEqual(["Default (Claude Opus 9)", "Claude Sonnet 5", "Claude Opus 9"])

    await choose("Agent", "Mine")
    expect(chipValue("Model")).toBe("Default (Claude Sonnet 5)")
    await choose("Agent", "Compass Agent")
    expect(chipValue("Model")).toBe("Default (Claude Sonnet 5)")
  })

  it("sends no model while on Default", async () => {
    const turns = stubFetch(CHOICES)
    render(<AgentChat {...chatProps()} />)
    await findChipButton("Model")
    await send("hello")
    await waitFor(() => expect(turns).toHaveBeenCalled())
    expect(JSON.parse(turns.mock.calls[0][1].body)).not.toHaveProperty("model")
  })

  it("sends the explicit pick, and remembers it per user and workspace", async () => {
    const turns = stubFetch(CHOICES)
    const { unmount } = render(<AgentChat {...chatProps()} />)
    await findChipButton("Model")
    await choose("Model", "Claude Sonnet 5")
    await send("hello")
    await waitFor(() => expect(turns).toHaveBeenCalled())
    expect(JSON.parse(turns.mock.calls[0][1].body)).toMatchObject({ model: "claude-sonnet-5" })
    expect(window.localStorage.getItem(KEY)).toBe("claude-sonnet-5")
    expect(window.localStorage.getItem(modelPickStorageKey("u2", "ws-1"))).toBeNull()
    expect(window.localStorage.getItem(modelPickStorageKey("u1", "ws-2"))).toBeNull()
    unmount()

    render(<AgentChat {...chatProps()} />)
    await waitFor(() => expect(chipValue("Model")).toBe("Claude Sonnet 5"))
  })

  it("an explicit pick survives an agent change; picking Default again clears the memory", async () => {
    stubFetch(CHOICES)
    render(<AgentChat {...chatProps()} />)
    await findChipButton("Model")
    await choose("Model", "Claude Sonnet 5")
    await choose("Agent", "Mine")
    expect(chipValue("Model")).toBe("Claude Sonnet 5")
    await choose("Model", "Default (Claude Sonnet 5)")
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it("resets to Default, and forgets, a remembered model that is no longer offered", async () => {
    window.localStorage.setItem(KEY, "claude-retired-1")
    const turns = stubFetch(CHOICES)
    render(<AgentChat {...chatProps()} />)
    await findChipButton("Model")
    await waitFor(() => expect(window.localStorage.getItem(KEY)).toBeNull())
    expect(chipValue("Model")).toBe("Default (Claude Opus 9)")
    await send("hello")
    await waitFor(() => expect(turns).toHaveBeenCalled())
    expect(JSON.parse(turns.mock.calls[0][1].body)).not.toHaveProperty("model")
  })

  it("does not judge a remembered pick before the choices have loaded (or when they fail to)", async () => {
    window.localStorage.setItem(KEY, "claude-opus-9")
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }))
    render(<AgentChat {...chatProps()} />)
    await act(async () => {})
    expect(window.localStorage.getItem(KEY)).toBe("claude-opus-9")
    expect(queryChipButton("Model")).toBeNull()
  })

  it("names the model a live run answers on, beside the agent's name", async () => {
    const run = { id: "r-1", conversationId: "c-1", status: "RUNNING", lastSeq: 0, done: false, error: null, errorCode: null, deadlineAt: "2099-01-01T00:00:00Z", startedByUserId: "u1", agentName: "Triage", model: "claude-opus-9" }
    stubFetch(CHOICES, (url) => (url.includes("/conversations/c-1/run") ? new Response(JSON.stringify({ run, available: true })) : url.startsWith("/api/agent/runs/") ? new Response("", { status: 404 }) : undefined))
    render(<AgentChat {...chatProps({ activeConversationId: "c-1" })} />)
    expect(await screen.findByText("Triage is answering on Claude Opus 9.")).toBeInTheDocument()
  })

  it("is disabled while a turn streams, like the agent selector", async () => {
    const stuck = vi.fn().mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => String(url).startsWith("/api/agent/choices") ? Promise.resolve({ ok: true, status: 200, json: async () => CHOICES }) : stuck(url, init))
    render(<AgentChat {...chatProps()} />)
    await findChipButton("Model")
    await send("hello")
    await waitFor(() => expect(chipButton("Model")).toBeDisabled())
    expect(chipButton("Agent")).toBeDisabled()
  })
})

describe("AgentChat model picker: workspace changes and early sends", () => {
  const OTHER_CHOICES = { ...CHOICES, agents: [], defaultAgentId: null, models: [MODELS[0], { value: "claude-haiku-9", label: "Claude Haiku 9" }], loaded: undefined }

  it("does not judge workspace B's remembered pick against workspace A's models when the workspace changes", async () => {
    window.localStorage.setItem(modelPickStorageKey("u1", "ws-2"), "claude-haiku-9")
    vi.stubGlobal("fetch", (url: string) =>
      String(url).startsWith("/api/agent/choices")
        ? Promise.resolve({ ok: true, status: 200, json: async () => (String(url).includes("ws-2") ? OTHER_CHOICES : { ...CHOICES, loaded: undefined }) })
        : Promise.reject(new Error("unexpected")),
    )
    const { rerender } = render(<AgentChat {...chatProps()} />)
    await findChipButton("Model")
    await choose("Model", "Claude Sonnet 5")
    rerender(<AgentChat {...chatProps({ workspaceId: "ws-2" })} />)
    await waitFor(() => expect(chipValue("Model")).toBe("Claude Haiku 9"))
    // Neither workspace's memory was clobbered by the other's choices.
    expect(window.localStorage.getItem(modelPickStorageKey("u1", "ws-2"))).toBe("claude-haiku-9")
    expect(window.localStorage.getItem(modelPickStorageKey("u1", "ws-1"))).toBe("claude-sonnet-5")
  })

  it("sends no model before the choices have loaded, even with a remembered pick (it is validated first)", async () => {
    window.localStorage.setItem(KEY, "claude-sonnet-5")
    const turns = vi.fn().mockImplementation(async () => sse())
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (String(url).startsWith("/api/agent/choices") ? new Promise(() => {}) : turns(url, init)))
    render(<AgentChat {...chatProps()} />)
    await send("early")
    await waitFor(() => expect(turns).toHaveBeenCalled())
    expect(JSON.parse(turns.mock.calls[0][1].body)).not.toHaveProperty("model")
    expect(window.localStorage.getItem(KEY)).toBe("claude-sonnet-5")
  })

  it("keeps the rail's and the page's chips independent when both are mounted", async () => {
    stubFetch(CHOICES)
    render(<><AgentChat {...chatProps()} /><AgentChat {...chatProps()} /></>)
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Model:/ })).toHaveLength(2))
    const [first, second] = screen.getAllByRole("button", { name: /^Model:/ })
    await act(async () => { fireEvent.click(first) })
    await screen.findByRole("listbox", { name: "Model" })
    expect(first).toHaveAttribute("aria-expanded", "true")
    expect(second).toHaveAttribute("aria-expanded", "false")
    expect(first.getAttribute("aria-controls")).not.toBe(second.getAttribute("aria-controls"))
  })
})
