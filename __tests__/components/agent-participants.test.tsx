// @vitest-environment jsdom

/**
 * The participants panel. The rules are enforced server-side; these
 * assert the presentation that depends on them: who sees which control, that an
 * unshareable or pre-migration conversation shows nothing, and that a 404 is
 * reported upward as lost access.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { AgentParticipantsPanel, type Roster } from "@/components/agent/agent-participants"

const OWNER = { userId: "owner-1", role: "OWNER" as const, name: "Olive Owner", addedByUserId: null }
const GUEST = { userId: "guest-1", role: "PARTICIPANT" as const, name: "Gus Guest", addedByUserId: "owner-1" }

function roster(overrides: Partial<Roster> = {}): Roster {
  return { available: true, viewerRole: "OWNER", participants: [OWNER], shareable: true, ...overrides }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

const onRoster = vi.fn()
const onAccessLost = vi.fn()

function renderPanel(userId: string) {
  return render(
    <AgentParticipantsPanel
      conversationId="c1"
      workspaceId="ws-1"
      userId={userId}
      onRoster={onRoster}
      onAccessLost={onAccessLost}
    />,
  )
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AgentParticipantsPanel", () => {
  it("renders nothing before the migration or for a conversation that cannot be shared", async () => {
    const fetchMock = vi.fn(async () => json(roster({ available: false })))
    vi.stubGlobal("fetch", fetchMock)
    const { container } = renderPanel("owner-1")
    await waitFor(() => expect(onRoster).toHaveBeenCalledWith(expect.objectContaining({ available: false })))
    expect(container).toBeEmptyDOMElement()

    cleanup()
    vi.stubGlobal("fetch", vi.fn(async () => json(roster({ shareable: false }))))
    const second = renderPanel("owner-1")
    await waitFor(() => expect(onRoster).toHaveBeenCalledWith(expect.objectContaining({ shareable: false })))
    expect(second.container).toBeEmptyDOMElement()
  })

  it("starts as 'Only you' and loads invite candidates only once opened", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      json(url.includes("candidates=1") ? roster({ candidates: [{ userId: "u2", name: "Una" }] }) : roster()),
    )
    vi.stubGlobal("fetch", fetchMock)
    renderPanel("owner-1")

    expect(await screen.findByText("Only you")).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("candidates=1"))).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: /only you/i }))
    expect(await screen.findByRole("option", { name: "Una" })).toBeInTheDocument()
  })

  it("invites the chosen member with a POST", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ ok: true })
      return json(roster({ candidates: [{ userId: "u2", name: "Una" }] }))
    })
    vi.stubGlobal("fetch", fetchMock)
    renderPanel("owner-1")

    fireEvent.click(await screen.findByRole("button", { name: /only you/i }))
    const select = await screen.findByLabelText("Invite a workspace member")
    await screen.findByRole("option", { name: "Una" })
    fireEvent.change(select, { target: { value: "u2" } })
    fireEvent.click(screen.getByRole("button", { name: "Invite" }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")
      expect(post).toBeTruthy()
      expect(JSON.parse(String(post![1]!.body))).toEqual({ userId: "u2" })
    })
  })

  it("offers the owner Remove on others but no Leave, and a participant Leave on themself only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(roster({ participants: [OWNER, GUEST] }))))
    renderPanel("owner-1")
    fireEvent.click(await screen.findByRole("button", { name: /shared with 1 person/i }))
    expect(await screen.findByRole("button", { name: "Remove Gus Guest" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Leave" })).toBeNull()

    cleanup()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(roster({ viewerRole: "PARTICIPANT", participants: [OWNER, GUEST] }))),
    )
    renderPanel("guest-1")
    fireEvent.click(await screen.findByRole("button", { name: /shared with 1 person/i }))
    expect(await screen.findByRole("button", { name: "Leave" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull()
  })

  it("reports 'left' after a successful self-removal", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? json({ ok: true }) : json(roster({ viewerRole: "PARTICIPANT", participants: [OWNER, GUEST] })),
    )
    vi.stubGlobal("fetch", fetchMock)
    renderPanel("guest-1")
    fireEvent.click(await screen.findByRole("button", { name: /shared with 1 person/i }))
    fireEvent.click(await screen.findByRole("button", { name: "Leave" }))
    await waitFor(() => expect(onAccessLost).toHaveBeenCalledWith("left"))
  })

  it("reports lost access when the roster 404s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })))
    renderPanel("guest-1")
    await waitFor(() => expect(onAccessLost).toHaveBeenCalledWith("removed"))
  })

  it("ignores a body that is not a roster", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ hello: "world" })))
    const { container } = renderPanel("owner-1")
    await new Promise((r) => setTimeout(r, 20))
    expect(container).toBeEmptyDOMElement()
    expect(onAccessLost).not.toHaveBeenCalled()
  })
})
