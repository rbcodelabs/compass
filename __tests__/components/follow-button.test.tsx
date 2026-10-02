// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { FollowButton } from "@/components/following/follow-button"

const fetchMock = vi.fn()
const reply = (body: unknown, ok = true) => Promise.resolve({ ok, json: async () => body })
const props = { orgSlug: "acme", workspaceSlug: "ws", subjectType: "TASK", subjectId: "t1" }

beforeEach(() => vi.stubGlobal("fetch", fetchMock))
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe("FollowButton", () => {
  it("asks the server for the caller's own state and reads Follow when not following", async () => {
    fetchMock.mockReturnValueOnce(reply({ available: true, following: false, muted: false }))
    render(<FollowButton {...props} />)
    const button = await screen.findByRole("button", { name: "Follow" })
    expect(button).toHaveAttribute("aria-pressed", "false")
    expect(fetchMock).toHaveBeenCalledWith("/api/following?orgSlug=acme&workspaceSlug=ws&subjectType=TASK&subjectId=t1")
  })

  it("renders nothing when following is unavailable (flag off or type not shipped)", async () => {
    fetchMock.mockReturnValueOnce(reply({ available: false }))
    const { container } = render(<FollowButton {...props} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when the state request fails rather than offering a broken control", async () => {
    fetchMock.mockReturnValueOnce(reply({}, false))
    const { container } = render(<FollowButton {...props} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(container).toBeEmptyDOMElement()
  })

  it("toggles optimistically and PUTs the new state", async () => {
    fetchMock.mockReturnValueOnce(reply({ available: true, following: false })).mockReturnValueOnce(reply({ available: true, following: true }))
    render(<FollowButton {...props} />)
    fireEvent.click(await screen.findByRole("button", { name: "Follow" }))
    const following = await screen.findByRole("button", { name: "Following" })
    expect(following).toHaveAttribute("aria-pressed", "true")
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe("/api/following")
    expect(init.method).toBe("PUT")
    expect(JSON.parse(init.body)).toEqual({ ...props, following: true })
  })

  it("unfollows from the following state", async () => {
    fetchMock.mockReturnValueOnce(reply({ available: true, following: true })).mockReturnValueOnce(reply({ available: true, following: false }))
    render(<FollowButton {...props} />)
    fireEvent.click(await screen.findByRole("button", { name: "Following" }))
    await screen.findByRole("button", { name: "Follow" })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ following: false })
  })

  it("rolls back and says so when the save fails", async () => {
    fetchMock.mockReturnValueOnce(reply({ available: true, following: false })).mockReturnValueOnce(reply({}, false))
    render(<FollowButton {...props} />)
    fireEvent.click(await screen.findByRole("button", { name: "Follow" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not follow")
    expect(screen.getByRole("button", { name: "Follow" })).toHaveAttribute("aria-pressed", "false")
  })

  it("ignores a stale response after the subject changes", async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockReturnValueOnce(reply({ available: true, following: false }))
    const { rerender } = render(<FollowButton {...props} />)
    rerender(<FollowButton {...props} subjectId="t2" />)
    await screen.findByRole("button", { name: "Follow" })
    resolveFirst({ ok: true, json: async () => ({ available: true, following: true }) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByRole("button", { name: "Follow" })).toBeInTheDocument()
  })
})
