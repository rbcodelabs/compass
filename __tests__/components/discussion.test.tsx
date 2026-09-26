// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Discussion } from "@/components/comments/discussion"

const fetchMock = vi.fn()
const comment = (overrides: Record<string, unknown> = {}) => ({
  id: "root-1", workspaceId: "workspace-1", targetType: "ROADMAP_ITEM", targetId: "target-1",
  parentId: null, body: "Root comment", status: "OPEN", authorId: "user-1", authorName: "Rick",
  authorType: "HUMAN", source: "UI", createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z", docAnchor: null, solutionPlanProposal: null,
  edited: false, canEdit: true, canDelete: true, canModerate: true, replies: [], ...overrides,
})
const jsonResponse = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("confirm", vi.fn(() => true))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Discussion", () => {
  it("preserves a draft typed before the initial load starts", async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [] }))
    render(<Discussion targetType="ARTIFACT" targetId="target-1" />)
    fireEvent.change(screen.getByRole("textbox", { name: "Add comment" }), { target: { value: "Immediate draft" } })
    await screen.findByText("No comments yet.")
    expect(screen.getByRole("textbox", { name: "Add comment" })).toHaveValue("Immediate draft")
  })
  it("waits for the initial discussion before allowing a post to cancel its load", async () => {
    let finishLoad!: (value: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finishLoad = resolve }))
    render(<Discussion targetType="ARTIFACT" targetId="target-1" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("button", { name: "Post comment" })).toBeDisabled()
    finishLoad(await jsonResponse({ items: [] }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Post comment" })).toBeEnabled())
  })
  it("consumes Escape in an editor before a containing panel can close", async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [comment()] }))
    const closePanel = vi.fn()
    render(<div onKeyDown={closePanel}><Discussion targetType="ARTIFACT" targetId="target-1" /></div>)
    await screen.findByText("Root comment")
    fireEvent.click(screen.getByRole("button", { name: "Reply to Rick" }))
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Reply to Rick" }), { key: "Escape" })
    expect(screen.queryByRole("textbox", { name: "Reply to Rick" })).toBeNull()
    expect(closePanel).not.toHaveBeenCalled()
  })

  it("does not let an older refresh erase a newly posted comment", async () => {
    let finishRefresh!: (value: Response) => void
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [] }))
    const { rerender } = render(<Discussion targetType="ARTIFACT" targetId="target-1" refreshKey={1} />)
    await screen.findByText("No comments yet.")
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finishRefresh = resolve }))
    rerender(<Discussion targetType="ARTIFACT" targetId="target-1" refreshKey={2} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    fetchMock.mockReturnValueOnce(jsonResponse(comment({ body: "New comment" })))
    fireEvent.change(screen.getByRole("textbox", { name: "Add comment" }), { target: { value: "New comment" } })
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }))
    await screen.findByText("New comment", { selector: "p" })
    finishRefresh(await jsonResponse({ items: [] }))
    await waitFor(() => expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true))
    expect(screen.getByText("New comment", { selector: "p" })).toBeVisible()
  })

  it("defers reopen refresh until a pending mutation finishes without resetting the draft", async () => {
    let finishPost!: (value: Response) => void
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [] }))
    const { rerender } = render(<Discussion targetType="ARTIFACT" targetId="target-1" refreshKey={1} />)
    await screen.findByText("No comments yet.")
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finishPost = resolve }))
    fireEvent.change(screen.getByRole("textbox", { name: "Add comment" }), { target: { value: "New comment" } })
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }))
    rerender(<Discussion targetType="ARTIFACT" targetId="target-1" refreshKey={2} />)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [comment({ body: "New comment" })] }))
    finishPost(await jsonResponse(comment({ body: "New comment" })))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(screen.getByText("New comment", { selector: "p" })).toBeVisible()
  })
  it("shows loading and then an accessible empty state", async () => {
    let finish: ((value: Response) => void) | undefined
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
    render(<Discussion targetType="ROADMAP_ITEM" targetId="target-1" />)

    expect(screen.getByText("Loading discussion…")).toBeVisible()
    finish?.(new Response(JSON.stringify({ items: [] }), { status: 200 }))
    expect(await screen.findByText("No comments yet.")).toBeVisible()
    expect(screen.getByRole("region", { name: "Discussion" })).toBeVisible()
  })

  it("shows the server error and retries loading", async () => {
    fetchMock
      .mockReturnValueOnce(jsonResponse({ error: "Discussion unavailable" }, 503))
      .mockReturnValueOnce(jsonResponse({ items: [] }))
    render(<Discussion targetType="ROADMAP_ITEM" targetId="target-1" />)

    expect(await screen.findByRole("alert")).toHaveTextContent("Discussion unavailable")
    fireEvent.click(screen.getByRole("button", { name: "Retry discussion" }))
    expect(await screen.findByText("No comments yet.")).toBeVisible()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("aborts stale loads and resets target-scoped state when the target changes", async () => {
    let finishA: ((value: Response) => void) | undefined
    fetchMock
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finishA = resolve }))
      .mockReturnValueOnce(jsonResponse({ items: [comment({ id: "root-b", targetId: "target-b", body: "Target B" })] }))
    const { rerender } = render(<Discussion targetType="ROADMAP_ITEM" targetId="target-a" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByRole("textbox", { name: "Add comment" }), { target: { value: "Draft for A" } })

    rerender(<Discussion targetType="ROADMAP_ITEM" targetId="target-b" />)
    expect(await screen.findByText("Target B")).toBeVisible()
    expect(screen.getByRole("textbox", { name: "Add comment" })).toHaveValue("")
    const firstSignal = fetchMock.mock.calls[0][1]?.signal as AbortSignal
    expect(firstSignal.aborted).toBe(true)

    finishA?.(await jsonResponse({ items: [comment({ body: "Late Target A" })] }))
    await waitFor(() => expect(screen.queryByText("Late Target A")).toBeNull())
    expect(screen.getByText("Target B")).toBeVisible()
  })

  it("ignores a delayed create continuation after switching targets", async () => {
    let finishCreate: ((value: Response) => void) | undefined
    fetchMock
      .mockReturnValueOnce(jsonResponse({ items: [] }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finishCreate = resolve }))
      .mockReturnValueOnce(jsonResponse({ items: [comment({ id: "root-b", targetId: "target-b", body: "Target B" })] }))
    const { rerender } = render(<Discussion targetType="ROADMAP_ITEM" targetId="target-a" />)
    await screen.findByText("No comments yet.")
    fireEvent.change(screen.getByRole("textbox", { name: "Add comment" }), { target: { value: "Created for A" } })
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }))

    rerender(<Discussion targetType="ROADMAP_ITEM" targetId="target-b" />)
    expect(await screen.findByText("Target B")).toBeVisible()
    finishCreate?.(await jsonResponse(comment({ body: "Created for A" }), 201))
    await waitFor(() => expect(screen.queryByText("Created for A")).toBeNull())
    expect(screen.getByRole("textbox", { name: "Add comment" })).toHaveValue("")
  })

  it("ignores a delayed destructive continuation after switching targets", async () => {
    let finishDelete: ((value: Response) => void) | undefined
    fetchMock
      .mockReturnValueOnce(jsonResponse({ items: [comment({ body: "Target A" })] }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finishDelete = resolve }))
      .mockReturnValueOnce(jsonResponse({ items: [comment({ id: "root-b", targetId: "target-b", body: "Target B" })] }))
    const { rerender } = render(<Discussion targetType="ROADMAP_ITEM" targetId="target-a" />)
    await screen.findByText("Target A")
    fireEvent.click(screen.getByRole("button", { name: "Delete comment by Rick" }))

    rerender(<Discussion targetType="ROADMAP_ITEM" targetId="target-b" />)
    expect(await screen.findByText("Target B")).toBeVisible()
    finishDelete?.(await jsonResponse({ id: "root-1", deletedReplies: 0 }))
    await waitFor(() => expect(screen.getByText("Target B")).toBeVisible())
    expect(screen.queryByText("Target A")).toBeNull()
  })

  it("orders threads and replies, labels agents and edits, and collapses resolved threads", async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [
      comment({ id: "later", body: "Later", createdAt: "2026-09-04T13:00:00.000Z" }),
      comment({ id: "resolved", body: "Resolved body", status: "RESOLVED", authorName: "Compass Agent", authorType: "AGENT", edited: true, canEdit: false, canDelete: false, createdAt: "2026-09-04T11:00:00.000Z", replies: [
        comment({ id: "reply-late", parentId: "resolved", body: "Reply later", createdAt: "2026-09-04T11:30:00.000Z" }),
        comment({ id: "reply-early", parentId: "resolved", body: "Reply early", createdAt: "2026-09-04T11:15:00.000Z" }),
      ] }),
    ] }))
    render(<Discussion targetType="ROADMAP_ITEM" targetId="target-1" />)

    expect(await screen.findByText("Compass Agent")).toBeVisible()
    expect(screen.getByText("Agent")).toBeVisible()
    expect(screen.getByText("Edited")).toBeVisible()
    expect(screen.queryByText("Resolved body")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Expand resolved thread by Compass Agent" }))
    const articles = screen.getAllByRole("article")
    expect(articles[0]).toHaveTextContent("Resolved body")
    expect(within(articles[0]).getAllByRole("article")[0]).toHaveTextContent("Reply early")
    expect(within(articles[0]).getAllByRole("article")[1]).toHaveTextContent("Reply later")
    expect(articles.at(-1)).toHaveTextContent("Later")
  })

  it("validates and adds a root comment without discarding the draft on failure", async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [] }))
    render(<Discussion targetType="ROADMAP_ITEM" targetId="target-1" />)
    await screen.findByText("No comments yet.")

    fireEvent.click(screen.getByRole("button", { name: "Post comment" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a comment")

    const input = screen.getByRole("textbox", { name: "Add comment" })
    fireEvent.change(input, { target: { value: "Keep this draft" } })
    fetchMock.mockReturnValueOnce(jsonResponse({ error: "Could not post" }, 500))
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not post")
    expect(input).toHaveValue("Keep this draft")

    fetchMock.mockReturnValueOnce(jsonResponse(comment({ body: "Keep this draft" }), 201))
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }))
    await waitFor(() => expect(input).toHaveValue(""))
    expect(screen.getByText("Keep this draft")).toBeVisible()
  })

  it("supports reply, edit, resolve and reopen using explicit API actions", async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [comment()] }))
    render(<Discussion targetType="ROADMAP_ITEM" targetId="target-1" />)
    await screen.findByText("Root comment")

    fireEvent.click(screen.getByRole("button", { name: "Reply to Rick" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Reply to Rick" }), { target: { value: "A reply" } })
    fetchMock.mockReturnValueOnce(jsonResponse(comment({ id: "reply-1", parentId: "root-1", body: "A reply" }), 201))
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }))
    expect(await screen.findByText("A reply", { selector: "p" })).toBeVisible()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ parentId: "root-1", body: "A reply" })

    fireEvent.click(screen.getAllByRole("button", { name: "Edit comment by Rick" })[0])
    const editor = screen.getByRole("textbox", { name: "Edit comment by Rick" })
    fireEvent.change(editor, { target: { value: "Edited root" } })
    fetchMock.mockReturnValueOnce(jsonResponse(comment({ body: "Edited root", edited: true })))
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }))
    expect(await screen.findByText("Edited root", { selector: "p" })).toBeVisible()

    fetchMock.mockReturnValueOnce(jsonResponse(comment({ body: "Edited root", status: "RESOLVED" })))
    fireEvent.click(screen.getByRole("button", { name: "Resolve thread by Rick" }))
    expect(await screen.findByRole("button", { name: "Reopen thread by Rick" })).toBeVisible()

    fetchMock.mockReturnValueOnce(jsonResponse(comment({ body: "Edited root", status: "OPEN" })))
    fireEvent.click(screen.getByRole("button", { name: "Reopen thread by Rick" }))
    expect(await screen.findByRole("button", { name: "Resolve thread by Rick" })).toBeVisible()
  })

  it("retains the edit on mutation failure and permits keyboard cancellation", async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [comment()] }))
    render(<Discussion targetType="ROADMAP_ITEM" targetId="target-1" />)
    await screen.findByText("Root comment")
    const trigger = screen.getByRole("button", { name: "Edit comment by Rick" })
    fireEvent.click(trigger)
    const editor = screen.getByRole("textbox", { name: "Edit comment by Rick" })
    fireEvent.change(editor, { target: { value: "Unsaved edit" } })
    fetchMock.mockReturnValueOnce(jsonResponse({ error: "Save failed" }, 500))
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed")
    expect(editor).toHaveValue("Unsaved edit")
    fireEvent.keyDown(editor, { key: "Escape" })
    expect(screen.queryByRole("textbox", { name: "Edit comment by Rick" })).toBeNull()
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit comment by Rick" })).toHaveFocus())
  })

  it("renders comment bodies as formatted markdown, not literal source", async () => {
    const markdownBody = "**bold** text\n\n## Heading\n\n| Repository | URL |\n| --- | --- |\n| compass | github.com/example/compass |"
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [comment({ body: markdownBody })] }))
    render(<Discussion targetType="ROADMAP_ITEM" targetId="target-1" />)

    const heading = await screen.findByRole("heading", { level: 2, name: "Heading" })
    expect(heading).toBeVisible()
    expect(screen.getByText("bold").closest("strong")).toBeVisible()
    expect(screen.getByRole("table")).toBeVisible()
    expect(screen.getByText("compass")).toBeVisible()
    expect(screen.queryByText(/##\s*Heading/)).toBeNull()
    expect(screen.queryByText(/\*\*bold\*\*/)).toBeNull()
  })

  it("hides normal deletion for a replied-to root and confirms an admin thread delete", async () => {
    const reply = comment({ id: "reply-1", parentId: "root-1", body: "Reply", canDelete: true })
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [comment({ canDelete: false, replies: [reply] })] }))
    const { rerender } = render(<Discussion targetType="ROADMAP_ITEM" targetId="target-1" />)
    await screen.findByText("Reply", { selector: "p" })
    expect(screen.queryByRole("button", { name: "Delete thread by Rick" })).toBeNull()

    fetchMock.mockReset()
    fetchMock.mockReturnValueOnce(jsonResponse({ items: [comment({ canDelete: true, replies: [reply] })] }))
    rerender(<Discussion targetType="ROADMAP_ITEM" targetId="target-2" />)
    await screen.findByRole("button", { name: "Delete thread by Rick" })
    fetchMock.mockReturnValueOnce(jsonResponse({ id: "root-1", deletedReplies: 1 }))
    fireEvent.click(screen.getByRole("button", { name: "Delete thread by Rick" }))
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/comments/root-1?deleteThread=true", expect.objectContaining({ method: "DELETE" })))
    expect(confirm).toHaveBeenCalled()
    expect(screen.queryByText("Root comment")).toBeNull()
  })
})
