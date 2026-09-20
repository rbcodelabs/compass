import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ auth: vi.fn(), lookup: vi.fn(), workspace: vi.fn(), doc: vi.fn(), versions: vi.fn(), comments: vi.fn(), cookie: vi.fn() }))
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookie }) }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("next/navigation", () => ({ redirect: () => { throw Error("redirect") }, notFound: () => { throw Error("not found") } }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findFirst: mocks.workspace }, doc: { findFirst: mocks.doc }, docVersion: { findMany: mocks.versions }, docComment: { findMany: mocks.comments }, task: { findMany: vi.fn().mockResolvedValue([]) }, workspaceMember: { findMany: vi.fn().mockResolvedValue([]) } }) }))
vi.mock("@/lib/tracked-decisions", () => ({ listDocDecisions: mocks.lookup }))
vi.mock("@/components/docs/doc-editor", () => ({ DocEditor: () => null }))
vi.mock("@/components/docs/doc-decision-action", () => ({ DocDecisionAction: () => null }))
import DocPage from "@/app/[orgSlug]/[workspaceSlug]/docs/[docId]/page"
const params = Promise.resolve({ orgSlug: "org", workspaceSlug: "space", docId: "doc" })
describe("Docs decision lookup authorization and fallback", () => {
  beforeEach(() => {
    mocks.cookie.mockReset()
    vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "user" } }); mocks.workspace.mockResolvedValue({ id: "workspace" }); mocks.doc.mockResolvedValue({ id: "doc", title: "Plan" }); mocks.versions.mockResolvedValue([]); mocks.comments.mockResolvedValue([]); mocks.lookup.mockResolvedValue({ pending: [{ id: "request", title: "Ship?" }], latestDecided: null })
  })
  it("passes minimal decision summaries to the toolbar after scoped document lookup", async () => {
    const page = await DocPage({ params })
    expect(mocks.workspace).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ members: { some: { userId: "user" } } }) }))
    expect(mocks.doc).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "doc", workspaceId: "workspace" } }))
    expect(mocks.lookup).toHaveBeenCalledWith("workspace", "doc")
    expect(page.props.decisionAction.props.decisions).toEqual({ pending: [{ id: "request", title: "Ship?" }], latestDecided: null })
  })
  it("passes independent server cookie preferences to the editor", async () => {
    mocks.cookie.mockImplementation((name: string) => ({ value: name === "compass_panel_docsComments" ? "1:600" : "0:360" }))
    const page = await DocPage({ params })
    expect(page.props.initialCommentsPin).toEqual({ pinned: true, width: 600 })
    expect(page.props.initialHistoryPin).toEqual({ pinned: false, width: 360 })
  })
  it("uses unpinned defaults for missing cookies", async () => {
    const page = await DocPage({ params })
    expect(page.props.initialCommentsPin).toEqual({ pinned: false, width: 448 })
    expect(page.props.initialHistoryPin).toEqual({ pinned: false, width: 448 })
  })
  it.each(["session", "workspace", "document"])("does not query decisions without %s access", async missing => {
    if (missing === "session") mocks.auth.mockResolvedValue(null)
    if (missing === "workspace") mocks.workspace.mockResolvedValue(null)
    if (missing === "document") mocks.doc.mockResolvedValue(null)
    await expect(DocPage({ params })).rejects.toThrow()
    expect(mocks.lookup).not.toHaveBeenCalled()
  })
  it("keeps the editor available and marks decision status unavailable on failure", async () => {
    mocks.lookup.mockRejectedValue(new Error("database unavailable"))
    const page = await DocPage({ params })
    expect(page.props.doc.title).toBe("Plan")
    expect(page.props.decisionAction.props.decisions).toBeNull()
  })
})
