/** get_spec handler (spec docs phase 3): resolved read with the same resolver and workspace scoping as the UI. */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  resolveById: vi.fn(),
  resolvePath: vi.fn(),
  readDocById: vi.fn(),
  resolveDocEmbeds: vi.fn(),
  listScopesForDoc: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  default: () => ({ workspace: { findUnique: async () => ({ slug: "alpha", organization: { slug: "acme" } }) } }),
}))
vi.mock("@/lib/document-mcp-actor", () => ({ documentMcpActor: () => ({ authorId: "user-alice", authorName: "MCP Agent" }) }))
vi.mock("@/lib/doc-fs", () => ({ resolveById: mocks.resolveById, resolvePath: mocks.resolvePath, readDocById: mocks.readDocById, listPaths: vi.fn() }))
vi.mock("@/lib/canvas-card-data", () => ({ resolveDocEmbeds: mocks.resolveDocEmbeds }))
vi.mock("@/lib/spec-docs/scopes", async () => ({ ...(await vi.importActual<object>("@/lib/spec-docs/scopes")), listScopesForDoc: mocks.listScopesForDoc }))

import { getSpec } from "@/lib/spec-tool-handlers"

const WS = "11111111-1111-4111-8111-111111111111"
const DOC = "33333333-3333-4333-8333-333333333333"
const SOL = "44444444-4444-4444-8444-444444444444"
const TASK = "55555555-5555-4555-8555-555555555555"
const GONE = "66666666-6666-4666-8666-666666666666"

const BODY = `# Spec\n\n[Cached sol title](compass://solution/${SOL})\n\nSee also [a task](compass://task/${TASK}) inline and again [x](compass://task/${TASK}).\n\n[Missing](compass://experiment/${GONE})\n`
const CONTENT = `---\ncompass_doc_id: ${DOC}\ncompass_doc_type: SPEC\ncompass_scopes:\n  - solution:${SOL}\n---\n${BODY}`

type Embed = { id: string; kind: string; state: string; title?: string; status?: string; facts?: unknown[] }
type SpecData = Record<string, unknown> & { embeds: Embed[]; markdown: string }
const card = (kind: string, id: string, title: string) => ({ state: "ok", kind, id, title, status: "ACTIVE", facts: [{ label: "Score", value: "80%" }], href: `/acme/alpha/x/${id}` })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveById.mockResolvedValue({ docId: DOC, path: "Spec - Checkout", title: "Spec - Checkout", docType: "SPEC" })
  mocks.resolvePath.mockResolvedValue({ docId: DOC, path: "Spec - Checkout", title: "Spec - Checkout", docType: "SPEC" })
  mocks.readDocById.mockResolvedValue({ docId: DOC, content: CONTENT, revision: "rev-1" })
  mocks.listScopesForDoc.mockResolvedValue([{ scopeType: "SOLUTION", scopeId: SOL }])
  mocks.resolveDocEmbeds.mockResolvedValue({
    cards: {
      [`solution:${SOL}`]: card("solution", SOL, "Live checkout"),
      [`task:${TASK}`]: card("task", TASK, "Live task"),
      [`experiment:${GONE}`]: { state: "unavailable", kind: "experiment", id: GONE },
    },
    deferred: [],
  })
})

describe("get_spec", () => {
  it("returns the markdown plus every embed's LIVE title, status and facts, and lists the unavailable refs explicitly", async () => {
    const result = await getSpec({ workspaceId: WS, docId: DOC })
    expect(result.structuredContent.ok).toBe(true)
    const data = result.structuredContent.data as SpecData
    expect(data).toMatchObject({ id: DOC, title: "Spec - Checkout", path: "Spec - Checkout", docType: "SPEC", revision: "rev-1", kinds: ["Spec"], scopes: [{ scopeType: "SOLUTION", scopeId: SOL }] })
    expect(data.markdown).toBe(CONTENT)
    expect(data.embeds).toHaveLength(3)
    expect(data.embeds.find((e: Embed) => e.id === SOL)).toMatchObject({ kind: "solution", state: "ok", title: "Live checkout", status: "ACTIVE", facts: [{ label: "Score", value: "80%" }] })
    expect(data.unavailable).toEqual([{ kind: "experiment", id: GONE }])
    // The cached title in the markdown link is a hint and never the reported title.
    expect(JSON.stringify(data.embeds)).not.toContain("Cached sol title")
    expect(result.content[0].text).toContain("Live checkout")
    expect(result.content[0].text).toMatch(/Unavailable[\s\S]*experiment/)
  })

  it("resolves with the same workspace-scoped resolver the UI uses: the doc id and the declared workspace, never one from a reference", async () => {
    await getSpec({ workspaceId: WS, docId: DOC })
    expect(mocks.resolveDocEmbeds).toHaveBeenCalledTimes(1)
    const input = mocks.resolveDocEmbeds.mock.calls[0][0]
    expect(input).toMatchObject({ docId: DOC, userId: "user-alice", expectedWorkspaceId: WS })
    expect(input.refs).toEqual([{ kind: "solution", id: SOL }, { kind: "task", id: TASK }, { kind: "experiment", id: GONE }])
    expect(input.refs).toHaveLength(3) // deduplicated: the task appears twice in the markdown
  })

  it("can be addressed by path", async () => {
    const result = await getSpec({ workspaceId: WS, path: "Spec - Checkout" })
    expect(mocks.resolvePath).toHaveBeenCalledWith(WS, "Spec - Checkout")
    expect((result.structuredContent.data as { id: string }).id).toBe(DOC)
  })

  it("needs a docId or a path", async () => {
    const result = await getSpec({ workspaceId: WS })
    expect(result.structuredContent).toMatchObject({ ok: false, message: "Provide docId or path." })
  })

  it("a missing doc, a doc in another workspace and a doc that is not a spec all fail with the same message", async () => {
    const messages: string[] = []
    mocks.resolveById.mockResolvedValue(null)
    messages.push((await getSpec({ workspaceId: WS, docId: DOC })).structuredContent.message)
    mocks.resolvePath.mockResolvedValue(null)
    messages.push((await getSpec({ workspaceId: WS, path: "nope" })).structuredContent.message)
    mocks.resolveById.mockResolvedValue({ docId: DOC, path: "Plain", title: "Plain", docType: "STANDARD" })
    messages.push((await getSpec({ workspaceId: WS, docId: DOC })).structuredContent.message)
    mocks.resolveById.mockResolvedValue({ docId: DOC, path: "Spec", title: "Spec", docType: "SPEC" })
    mocks.readDocById.mockResolvedValue(null)
    messages.push((await getSpec({ workspaceId: WS, docId: DOC })).structuredContent.message)
    expect(new Set(messages)).toEqual(new Set(["Spec not found in this workspace."]))
    expect(mocks.resolveDocEmbeds).not.toHaveBeenCalled()
  })

  it("an unscoped spec says so, and a spec linked to both kinds reports both labels", async () => {
    mocks.listScopesForDoc.mockResolvedValue([])
    expect((await getSpec({ workspaceId: WS, docId: DOC })).structuredContent.data).toMatchObject({ kinds: ["Spec (unscoped)"], scopes: [] })
    mocks.listScopesForDoc.mockResolvedValue([{ scopeType: "SOLUTION", scopeId: SOL }, { scopeType: "OPPORTUNITY", scopeId: GONE }])
    expect((await getSpec({ workspaceId: WS, docId: DOC })).structuredContent.data).toMatchObject({ kinds: ["Spec", "Discovery Plan"] })
  })

  it("keeps asking until every deferred reference is resolved, so the agent read is complete", async () => {
    mocks.resolveDocEmbeds
      .mockResolvedValueOnce({ cards: { [`solution:${SOL}`]: card("solution", SOL, "Live checkout") }, deferred: [{ kind: "task", id: TASK }, { kind: "experiment", id: GONE }] })
      .mockResolvedValueOnce({ cards: { [`task:${TASK}`]: card("task", TASK, "Live task"), [`experiment:${GONE}`]: { state: "unavailable", kind: "experiment", id: GONE } }, deferred: [] })
    const data = (await getSpec({ workspaceId: WS, docId: DOC })).structuredContent.data as { embeds: unknown[] }
    expect(mocks.resolveDocEmbeds).toHaveBeenCalledTimes(2)
    expect(mocks.resolveDocEmbeds.mock.calls[1][0].refs).toEqual([{ kind: "task", id: TASK }, { kind: "experiment", id: GONE }])
    expect(data.embeds).toHaveLength(3)
  })

  it("a doc with no embeds does not call the resolver", async () => {
    mocks.readDocById.mockResolvedValue({ docId: DOC, content: `---\ncompass_doc_id: ${DOC}\n---\n# Empty\n`, revision: null })
    const data = (await getSpec({ workspaceId: WS, docId: DOC })).structuredContent.data as { embeds: unknown[]; unavailable: unknown[] }
    expect(mocks.resolveDocEmbeds).not.toHaveBeenCalled()
    expect(data.embeds).toEqual([])
    expect(data.unavailable).toEqual([])
  })

  it("an embed the resolver did not answer is reported unavailable rather than dropped", async () => {
    mocks.resolveDocEmbeds.mockResolvedValue({ cards: {}, deferred: [] })
    const data = (await getSpec({ workspaceId: WS, docId: DOC })).structuredContent.data as { unavailable: unknown[] }
    expect(data.unavailable).toHaveLength(3)
  })
})
