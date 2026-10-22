// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useAgentTurn, type TurnSettlement } from "@/components/agent/use-agent-turn"

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const text = (t: string) => ({ message: { message: { content: [{ type: "text", text: t }] } } })
const sse = (...frames: string[]) =>
  new Response(new ReadableStream({ start(c) { frames.forEach((f) => c.enqueue(new TextEncoder().encode(f))); c.close() } }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const run = (over: Record<string, unknown> = {}) => ({ id: "r1", status: "SUCCEEDED", done: true, startedByUserId: "u1", ...over })

function setup() {
  const onConversationCreated = vi.fn()
  const onSettled = vi.fn<(s: TurnSettlement) => void>()
  const hook = renderHook(() => useAgentTurn({ workspaceId: "w1", onConversationCreated, onSettled }))
  return { ...hook, onConversationCreated, onSettled }
}

describe("useAgentTurn", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it("settles an inline stream and reports the new conversation first", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(sse(
      frame("status", { phase: "running", conversationId: "c1" }),
      frame("agent", text("Hello ")),
      frame("agent", text("there")),
      frame("result", { text: "Hello there", conversationId: "c1" }),
    ))
    const { result, onConversationCreated, onSettled } = setup()
    await act(async () => { await result.current.start({ message: "hi", pageUrl: "/acme/p" }) })

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
    expect(body).toMatchObject({ workspaceId: "w1", message: "hi", pageUrl: "/acme/p" })
    expect(onConversationCreated).toHaveBeenCalledWith("c1", { detached: false })
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0][0]).toMatchObject({ detached: false, assistant: { content: "Hello there" } })
    expect(result.current.phase).toBe("idle")
    expect(result.current.error).toBeNull()
  })

  it("watches a detached run to completion", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ runId: "r1", conversationId: "c9" }), { status: 202 }))
      .mockResolvedValueOnce(sse(
        frame("run", run({ done: false, status: "RUNNING" })),
        frame("event", { seq: 1, type: "agent", payload: text("Answer") }),
        frame("run", run()),
        frame("done", {}),
      ))
    const { result, onConversationCreated, onSettled } = setup()
    await act(async () => { await result.current.start({ message: "q" }) })

    expect(onConversationCreated).toHaveBeenCalledWith("c9", { detached: true })
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0][0]).toMatchObject({ detached: true, assistant: { id: "run-r1", content: "Answer" } })
    expect(result.current.transport).toBe("run")
    expect(result.current.activeRun).toBeNull()
  })

  it("refuses a second turn while one is in flight", async () => {
    let release!: (r: Response) => void
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve }))
    const { result } = setup()
    let first!: Promise<boolean>
    act(() => { first = result.current.start({ message: "one" }) })
    let second = true
    await act(async () => { second = await result.current.start({ message: "two" }) })
    expect(second).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => { release(sse(frame("result", { text: "ok" }))); await first })
  })

  it("surfaces a failed request as an error and does not settle", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("nope", { status: 500 }))
    const { result, onSettled } = setup()
    await act(async () => { await result.current.start({ message: "q" }) })
    expect(result.current.error).toBe("nope")
    expect(result.current.phase).toBe("idle")
    expect(onSettled).not.toHaveBeenCalled()
    // And the hook is usable again.
    expect(result.current.sending.current).toBe(false)
  })

  it("shows the sentence, not the JSON, when an agent cap refuses the turn (429 AGENT_CAP_REACHED)", async () => {
    const body = { error: "This agent already has 5 runs in progress (limit 5).", code: "AGENT_CAP_REACHED", cap: "CONCURRENT", limit: 5 }
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json" } }))
    const { result, onSettled } = setup()
    await act(async () => { await result.current.start({ message: "q", agentId: "a1" }) })
    expect(result.current.error).toBe(body.error)
    expect(onSettled).not.toHaveBeenCalled()
  })

  it("applies a Stop pressed before the run id is known", async () => {
    let release!: (r: Response) => void
    vi.mocked(fetch)
      .mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve }))
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // DELETE
      .mockResolvedValueOnce(sse(frame("run", run({ status: "CANCELLED", done: true, error: null })), frame("done", {})))
    const { result } = setup()
    let started!: Promise<boolean>
    act(() => { started = result.current.start({ message: "q" }) })
    await act(async () => { await result.current.cancel() })
    await act(async () => {
      release(new Response(JSON.stringify({ runId: "r1", conversationId: "c1" }), { status: 202 }))
      await started
    })
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === "/api/agent/runs/r1" && init?.method === "DELETE")).toBe(true)
    })
  })

  it("reset hangs up and frees the hook without touching the run", async () => {
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(() => {}))
    const { result } = setup()
    act(() => { void result.current.start({ message: "q" }) })
    expect(result.current.phase).toBe("booting")
    act(() => result.current.reset())
    expect(result.current.phase).toBe("idle")
    expect(result.current.sending.current).toBe(false)
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== "DELETE")).toBe(true)
  })
})
