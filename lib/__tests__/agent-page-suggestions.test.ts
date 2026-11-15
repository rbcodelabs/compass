import { beforeEach, describe, expect, it, vi } from "vitest"

const authMock = vi.fn()
const prismaMock = {
  workspace: { findFirst: vi.fn() },
  doc: { findFirst: vi.fn(), findMany: vi.fn() },
  opportunity: { findFirst: vi.fn(), findMany: vi.fn() },
  solution: { findFirst: vi.fn(), findMany: vi.fn() },
  roadmapItem: { findFirst: vi.fn(), findMany: vi.fn() },
  oKRCycle: { findFirst: vi.fn() },
  objective: { findFirst: vi.fn(), findMany: vi.fn() },
  keyResult: { findFirst: vi.fn(), findMany: vi.fn() },
  task: { findFirst: vi.fn(), findMany: vi.fn() },
  agentMessage: { aggregate: vi.fn() },
}
const resolveWorkItemMock = vi.fn()
const getDocumentStoreMock = vi.fn()
const generateTextMock = vi.fn()

vi.mock("@/auth", () => ({
  auth: () => authMock(),
}))

vi.mock("@/lib/db", () => ({
  default: () => prismaMock,
}))

vi.mock("@/lib/work-item-resolve", () => ({
  resolveWorkItem: (...args: unknown[]) => resolveWorkItemMock(...args),
}))

vi.mock("@/lib/document-storage", () => ({
  getDocumentStore: (...args: unknown[]) => getDocumentStoreMock(...args),
  isDocumentPilotWorkspace: () => false,
}))

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}))

import { encryptAnthropicApiKey } from "@/lib/workspace-anthropic-key"
import {
  USER_SUGGESTIONS_MAX_UNCACHED_CALLS,
  consumePageSuggestionRateLimit,
  resetPageSuggestionsServerState,
  resolvePageSuggestionContext,
} from "@/lib/agent-page-suggestions"
import {
  ANTHROPIC_SUGGESTIONS_MODEL,
  GATEWAY_SUGGESTIONS_MODEL,
  generatePageSuggestions,
  parseAndValidateSuggestions,
} from "@/lib/agent-page-suggestions-model"
import { GET } from "@/app/api/agent/page-suggestions/route"

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const DOC_ID = "22222222-2222-4222-8222-222222222222"
const OPP_ID = "33333333-3333-4333-8333-333333333333"
const SOL_ID = "44444444-4444-4444-8444-444444444444"
const RM_ID = "55555555-5555-4555-8555-555555555555"
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
const WRONG_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64")

const baseWorkspace = {
  id: WORKSPACE_ID,
  orgSlug: "acme",
  workspaceSlug: "compass",
  name: "Compass Core",
  thinkingModel: null,
  thinkingModelLabels: null,
  nowLimit: 3,
  nextLimit: 5,
}

beforeEach(() => {
  vi.clearAllMocks()
  resetPageSuggestionsServerState()

  prismaMock.oKRCycle.findFirst.mockResolvedValue(null)
  prismaMock.opportunity.findMany.mockResolvedValue([])
  prismaMock.roadmapItem.findMany.mockResolvedValue([])
  prismaMock.solution.findMany.mockResolvedValue([])
  prismaMock.task.findMany.mockResolvedValue([])
  prismaMock.agentMessage.aggregate.mockResolvedValue({
    _count: { _all: 0 },
    _sum: { costUsd: 0 },
  })
  resolveWorkItemMock.mockImplementation(
    async (_db: unknown, _wsId: string, _type: string, id: string) => ({ ok: true, id }),
  )
})

describe("resolvePageSuggestionContext", () => {
  it("rejects cross-workspace, /agent, and malformed/external URLs", async () => {
    expect(
      await resolvePageSuggestionContext({
        pageUrl: "/other-org/compass/roadmap",
        workspace: baseWorkspace,
      }),
    ).toBeNull()

    expect(
      await resolvePageSuggestionContext({
        pageUrl: "/acme/other-ws/roadmap",
        workspace: baseWorkspace,
      }),
    ).toBeNull()

    expect(
      await resolvePageSuggestionContext({
        pageUrl: "/acme/compass/agent",
        workspace: baseWorkspace,
      }),
    ).toBeNull()

    expect(
      await resolvePageSuggestionContext({
        pageUrl: "https://evil.example/acme/compass/roadmap",
        workspace: baseWorkspace,
      }),
    ).toBeNull()

    expect(
      await resolvePageSuggestionContext({
        pageUrl: "//evil.example/acme/compass/roadmap",
        workspace: baseWorkspace,
      }),
    ).toBeNull()

    expect(
      await resolvePageSuggestionContext({
        pageUrl: "/acme/compass/%E0%A4%A",
        workspace: baseWorkspace,
      }),
    ).toBeNull()
  })

  it("resolves DB-backed rich docs in reading mode with headings and legacy/uuid revision keys", async () => {
    const updatedAt = new Date("2026-11-10T12:00:00.000Z")
    const richBody = [
      "# Q4 Discovery Synthesis",
      "## Enterprise Onboarding Friction",
      "Enterprise admins spend an average of 42 minutes configuring SSO and role mappings before inviting teammates.",
      "### Top Interview Themes",
      "Customers repeatedly asked for a dry-run preview before enforcing workspace-wide SAML policies.",
    ].join("\n\n")

    prismaMock.doc.findFirst.mockImplementation(async ({ select }: { select?: Record<string, boolean> }) => {
      if (select && !select.content) {
        return { id: DOC_ID, title: "Q4 Discovery Synthesis", docType: "STANDARD" }
      }
      return {
        id: DOC_ID,
        title: "Q4 Discovery Synthesis",
        docType: "STANDARD",
        kind: "NOTE",
        content: richBody,
        storageProvider: null,
        contentRef: null,
        revision: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        updatedAt,
      }
    })

    const ctx = await resolvePageSuggestionContext({
      pageUrl: `/acme/compass/docs/${DOC_ID}?filter=recent`,
      workspace: baseWorkspace,
    })

    expect(ctx).not.toBeNull()
    expect(ctx?.mode).toBe("reading")
    expect(ctx?.label).toBe("Q4 Discovery Synthesis")
    expect(ctx?.path).toBe(`/acme/compass/docs/${DOC_ID}`)
    expect(ctx?.revisionKey).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    expect(ctx?.groundingLines.join("\n")).toContain("# Q4 Discovery Synthesis")
    expect(ctx?.groundingLines.join("\n")).toContain("## Enterprise Onboarding Friction")
  })

  it("hydrates GEODE-stored docs via hydrateDocument and marks blank/stub docs as authoring mode", async () => {
    const updatedAt = new Date("2026-11-11T09:30:00.000Z")

    // 1. GEODE rich doc -> reading
    getDocumentStoreMock.mockResolvedValue({
      readContent: vi.fn().mockResolvedValue({
        status: "ok",
        text: "# Positioning Brief\n\nCompass connects discovery evidence directly to roadmap commitments so PMs stop losing rationale across tools.",
      }),
    })
    prismaMock.doc.findFirst.mockImplementation(async ({ select }: { select?: Record<string, boolean> }) => {
      if (select && !select.content) {
        return { id: DOC_ID, title: "Compass Positioning Brief", docType: "GTM_POSITIONING_BRIEF" }
      }
      return {
        id: DOC_ID,
        title: "Compass Positioning Brief",
        docType: "GTM_POSITIONING_BRIEF",
        kind: null,
        content: null,
        storageProvider: "GEODE",
        contentRef: JSON.stringify({ key: "geode/doc-1" }),
        revision: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        updatedAt,
      }
    })

    const richGeodeCtx = await resolvePageSuggestionContext({
      pageUrl: `/acme/compass/docs/${DOC_ID}`,
      workspace: baseWorkspace,
    })
    expect(richGeodeCtx?.mode).toBe("reading")
    expect(richGeodeCtx?.revisionKey).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    expect(richGeodeCtx?.groundingLines.join("\n")).toContain("Compass connects discovery evidence")

    // 2. Stub doc (< 50 non-whitespace chars) -> authoring
    prismaMock.doc.findFirst.mockImplementation(async ({ select }: { select?: Record<string, boolean> }) => {
      if (select && !select.content) {
        return { id: DOC_ID, title: "Untitled RFC", docType: "STANDARD" }
      }
      return {
        id: DOC_ID,
        title: "Untitled RFC",
        docType: "STANDARD",
        kind: "ADR",
        content: "# Draft\n\nTBD",
        storageProvider: null,
        contentRef: null,
        revision: null,
        updatedAt,
      }
    })

    const stubCtx = await resolvePageSuggestionContext({
      pageUrl: `/acme/compass/docs/${DOC_ID}`,
      workspace: baseWorkspace,
    })
    expect(stubCtx?.mode).toBe("authoring")
    expect(stubCtx?.label).toBe("Untitled RFC")
    expect(stubCtx?.revisionKey).toBe(`legacy:${updatedAt.toISOString()}`)
  })

  it("resolves opportunity, solution, roadmapItem entities and the roadmap board section", async () => {
    const oppUpdated = new Date("2026-11-12T08:00:00.000Z")
    prismaMock.opportunity.findFirst.mockResolvedValue({
      id: OPP_ID,
      title: "Reduce first-session setup drop-off",
      status: "EXPLORING",
      customerSegment: "Mid-market PM leads",
      description: "New workspaces stall when importing existing roadmap spreadsheets.",
      updatedAt: oppUpdated,
      solutions: [{ title: "Guided CSV mapper", status: "TESTING" }],
      _count: { solutions: 1, feedback: 4 },
    })

    const oppCtx = await resolvePageSuggestionContext({
      pageUrl: `/acme/compass/discovery?detail=opportunity:${OPP_ID}`,
      workspace: baseWorkspace,
    })
    expect(oppCtx?.label).toBe("Reduce first-session setup drop-off")
    expect(oppCtx?.mode).toBe("reading")
    expect(oppCtx?.revisionKey).toBe(oppUpdated.toISOString())
    expect(oppCtx?.groundingLines.join("\n")).toContain("1 solutions, 4 feedback items")

    const solUpdated = new Date("2026-11-12T09:00:00.000Z")
    prismaMock.solution.findFirst.mockResolvedValue({
      id: SOL_ID,
      title: "Guided CSV mapper",
      status: "TESTING",
      description: "Interactive column mapping with live preview.",
      updatedAt: solUpdated,
      opportunity: { title: "Reduce first-session setup drop-off" },
      assumptions: [
        { title: "Admins have clean CSV exports", status: "UNTESTED", riskLevel: "HIGH" },
        { title: "Preview catches 90% of field mismatches", status: "VALIDATED", riskLevel: "MEDIUM" },
      ],
      roadmapItems: [{ title: "CSV import v1", horizon: "NOW" }],
    })

    const solCtx = await resolvePageSuggestionContext({
      pageUrl: `/acme/compass/solutions?detail=solution:${SOL_ID}`,
      workspace: baseWorkspace,
    })
    expect(solCtx?.label).toBe("Guided CSV mapper")
    expect(solCtx?.revisionKey).toBe(solUpdated.toISOString())
    expect(solCtx?.groundingLines.join("\n")).toContain("2 total (1 untested, 1 high-risk untested)")

    const rmUpdated = new Date("2026-11-12T10:00:00.000Z")
    prismaMock.roadmapItem.findFirst.mockResolvedValue({
      id: RM_ID,
      title: "CSV import v1",
      horizon: "NOW",
      status: "ACTIVE",
      startDate: new Date("2026-11-01T00:00:00.000Z"),
      endDate: new Date("2026-11-30T00:00:00.000Z"),
      description: "Ship guided CSV importer for opportunities and roadmap items.",
      updatedAt: rmUpdated,
      opportunity: { title: "Reduce first-session setup drop-off" },
      solution: { title: "Guided CSV mapper" },
      keyResult: { title: "Increase week-1 workspace activation to 65%" },
    })

    const rmCtx = await resolvePageSuggestionContext({
      pageUrl: `/acme/compass/roadmap?detail=roadmapItem:${RM_ID}`,
      workspace: baseWorkspace,
    })
    expect(rmCtx?.label).toBe("CSV import v1")
    expect(rmCtx?.revisionKey).toBe(rmUpdated.toISOString())
    expect(rmCtx?.groundingLines.join("\n")).toContain("Horizon: NOW")

    // Roadmap board section (`entity === null`)
    prismaMock.roadmapItem.findMany.mockResolvedValue([
      { title: "CSV import v1", horizon: "NOW" },
      { title: "SAML dry-run preview", horizon: "NOW" },
      { title: "Slack digest v2", horizon: "NEXT" },
    ])
    const boardCtx1 = await resolvePageSuggestionContext({
      pageUrl: "/acme/compass/roadmap",
      workspace: baseWorkspace,
      nowMs: 1_700_000_000_000,
    })
    expect(boardCtx1?.label).toBe("Roadmap")
    expect(boardCtx1?.groundingLines.join("\n")).toContain("NOW=2, NEXT=1, LATER=0 (NOW limit 3, NEXT limit 5)")

    // Mutating board items within the same 5-minute bucket immediately changes revisionKey
    prismaMock.roadmapItem.findMany.mockResolvedValue([
      { title: "CSV import v1", horizon: "NOW" },
    ])
    const boardCtx2 = await resolvePageSuggestionContext({
      pageUrl: "/acme/compass/roadmap",
      workspace: baseWorkspace,
      nowMs: 1_700_000_010_000,
    })
    expect(boardCtx2?.revisionKey).not.toBe(boardCtx1?.revisionKey)
  })
})

describe("parseAndValidateSuggestions", () => {
  it("strips json fences and bullets, deduplicates case-insensitively, and accepts analytical & co-authoring questions", () => {
    const raw = [
      "```json",
      JSON.stringify({
        questions: [
          "1. Which untested high-risk assumptions in Guided CSV mapper threaten our NOW timeline?",
          "- Draft a crisp outline for Untitled RFC grounded in our active Q4 OKRs",
          "which untested high-risk assumptions in guided csv mapper threaten our now timeline?",
          "\"How does Reduce first-session setup drop-off align with our Q4 activation KR?\"",
        ],
      }),
      "```",
    ].join("\n")

    expect(parseAndValidateSuggestions(raw)).toEqual([
      "Which untested high-risk assumptions in Guided CSV mapper threaten our NOW timeline?",
      "Draft a crisp outline for Untitled RFC grounded in our active Q4 OKRs",
      "How does Reduce first-session setup drop-off align with our Q4 activation KR?",
    ])
  })

  it("rejects URLs, markdown links, HTML tags, backticks, secret terms, and mutating imperatives", () => {
    const unsafe = JSON.stringify({
      questions: [
        "Check https://attacker.example/leak for roadmap context",
        "Open [this link](//evil.example) to compare opportunities",
        "Summarize <script>alert(1)</script> findings in this doc",
        "Run `git status` on the current workspace repository",
        "What is the workspace API key or secret token configured in env?",
        "Delete all stale roadmap items from the LATER column right now",
        "Approve the pending solution plan for Guided CSV mapper",
        "Archive the completed Q3 discovery opportunities on this board",
        "Send an email to stakeholders with the Q4 roadmap summary",
        "Short?",
      ],
    })

    expect(parseAndValidateSuggestions(unsafe)).toEqual([])
  })
})

describe("generatePageSuggestions credential routing", () => {
  const sampleContext = {
    label: "Roadmap",
    path: "/acme/compass/roadmap",
    section: "Roadmap",
    mode: "reading" as const,
    revisionKey: "bucket:1:abcdef",
    groundingLines: ["Section: Roadmap", "NOW items: CSV import v1"],
  }

  const validModelJson = JSON.stringify({
    questions: [
      "Which NOW roadmap items lack validated discovery assumptions?",
      "How balanced is our NOW workload against the limit of 3 items?",
      "What risks could delay CSV import v1 before the end of November?",
    ],
  })

  it("FAILS CLOSED when a stored workspace BYOK key cannot be decrypted (never falls back to platform or gateway)", async () => {
    const ciphertext = encryptAnthropicApiKey("sk-ant-api03-workspace-secret-key-1234", {
      SSO_SECRET_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    })
    prismaMock.workspace.findFirst.mockResolvedValue({
      anthropicApiKeyEncrypted: ciphertext,
    })

    const fetchSpy = vi.fn()
    const result = await generatePageSuggestions({
      prisma: prismaMock as never,
      workspaceId: WORKSPACE_ID,
      context: sampleContext,
      // Wrong encryption key -> decryption fails, even though platform & gateway keys exist!
      env: {
        SSO_SECRET_ENCRYPTION_KEY: WRONG_ENCRYPTION_KEY,
        ANTHROPIC_API_KEY: "sk-ant-api03-platform-key-9999",
        AI_GATEWAY_API_KEY: "gw-key-9999",
      },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })

    expect(result).toEqual({ suggestions: [], credentialSource: null })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(generateTextMock).not.toHaveBeenCalled()
  })

  it("uses the decrypted workspace BYOK key with claude-haiku-4-5 and wraps workspace data in <untrusted_workspace_content>", async () => {
    const byokPlain = "sk-ant-api03-workspace-secret-key-5678"
    const ciphertext = encryptAnthropicApiKey(byokPlain, {
      SSO_SECRET_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    })
    prismaMock.workspace.findFirst.mockResolvedValue({
      anthropicApiKeyEncrypted: ciphertext,
    })

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: validModelJson }] }),
    })

    const result = await generatePageSuggestions({
      prisma: prismaMock as never,
      workspaceId: WORKSPACE_ID,
      context: sampleContext,
      env: {
        SSO_SECRET_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        ANTHROPIC_API_KEY: "sk-ant-api03-platform-should-not-be-used",
      },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })

    expect(result.credentialSource).toBe("workspace-api-key")
    expect(result.suggestions).toHaveLength(3)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.anthropic.com/v1/messages")
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(byokPlain)
    const body = JSON.parse(init.body as string) as { model: string; messages: Array<{ content: string }> }
    expect(body.model).toBe(ANTHROPIC_SUGGESTIONS_MODEL)
    expect(body.messages[0].content).toContain("<untrusted_workspace_content>")
    expect(body.messages[0].content).toContain("NOW items: CSV import v1")
  })

  it("routes to platform ANTHROPIC_API_KEY when no workspace BYOK key is stored", async () => {
    prismaMock.workspace.findFirst.mockResolvedValue({ anthropicApiKeyEncrypted: null })
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: validModelJson }] }),
    })

    const result = await generatePageSuggestions({
      prisma: prismaMock as never,
      workspaceId: WORKSPACE_ID,
      context: sampleContext,
      env: { ANTHROPIC_API_KEY: "sk-ant-api03-platform-key-4321" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })

    expect(result.credentialSource).toBe("platform-api-key")
    expect(result.suggestions).toHaveLength(3)
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-api03-platform-key-4321")
  })

  it("falls back to AI Gateway generateText with anthropic/claude-haiku-4.5 when no Anthropic API key is configured", async () => {
    prismaMock.workspace.findFirst.mockResolvedValue({ anthropicApiKeyEncrypted: null })
    generateTextMock.mockResolvedValue({ text: validModelJson })

    const fetchSpy = vi.fn()
    const result = await generatePageSuggestions({
      prisma: prismaMock as never,
      workspaceId: WORKSPACE_ID,
      context: sampleContext,
      env: { AI_GATEWAY_API_KEY: "gw-token-123" },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })

    expect(result.credentialSource).toBe("gateway")
    expect(result.suggestions).toHaveLength(3)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: GATEWAY_SUGGESTIONS_MODEL,
        maxOutputTokens: 220,
      }),
    )
  })

  it("returns empty suggestions and null credentialSource when no credentials exist anywhere", async () => {
    prismaMock.workspace.findFirst.mockResolvedValue({ anthropicApiKeyEncrypted: null })

    const result = await generatePageSuggestions({
      prisma: prismaMock as never,
      workspaceId: WORKSPACE_ID,
      context: sampleContext,
      env: {},
      getOidc: async () => "",
    })

    expect(result).toEqual({ suggestions: [], credentialSource: null })
  })
})

describe("GET /api/agent/page-suggestions", () => {
  const workspaceRow = {
    id: WORKSPACE_ID,
    slug: "compass",
    name: "Compass Core",
    thinkingModel: null,
    thinkingModelLabels: null,
    nowLimit: 3,
    nextLimit: 5,
    organization: { slug: "acme" },
    anthropicApiKeyEncrypted: null,
  }

  it("returns 401 when unauthenticated and 404 when caller is not a workspace member", async () => {
    authMock.mockResolvedValueOnce(null)
    const unauthRes = await GET(
      new Request(`http://localhost/api/agent/page-suggestions?workspaceId=${WORKSPACE_ID}&pageUrl=/acme/compass/roadmap`),
    )
    expect(unauthRes.status).toBe(401)

    authMock.mockResolvedValueOnce({ user: { id: "user-non-member" } })
    prismaMock.workspace.findFirst.mockResolvedValueOnce(null)
    const nonMemberRes = await GET(
      new Request(`http://localhost/api/agent/page-suggestions?workspaceId=${WORKSPACE_ID}&pageUrl=/acme/compass/roadmap`),
    )
    expect(nonMemberRes.status).toBe(404)
  })

  it("serves repeat requests from the server LRU cache without a second model call", async () => {
    const prevGatewayKey = process.env.AI_GATEWAY_API_KEY
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY
    process.env.AI_GATEWAY_API_KEY = "gw-test-key"
    delete process.env.ANTHROPIC_API_KEY

    try {
      authMock.mockResolvedValue({ user: { id: "user-1" } })
      prismaMock.workspace.findFirst.mockResolvedValue(workspaceRow)
      prismaMock.roadmapItem.findMany.mockResolvedValue([{ title: "CSV import v1", horizon: "NOW" }])
      generateTextMock.mockResolvedValue({
        text: JSON.stringify({
          questions: [
            "Which NOW roadmap items lack validated discovery assumptions?",
            "How balanced is our NOW column against the WIP limit of 3?",
            "What delivery risks affect CSV import v1 this cycle?",
          ],
        }),
      })

      const url = `http://localhost/api/agent/page-suggestions?workspaceId=${WORKSPACE_ID}&pageUrl=${encodeURIComponent("/acme/compass/roadmap")}`
      const first = await GET(new Request(url))
      expect(first.status).toBe(200)
      const firstJson = await first.json()
      expect(firstJson.label).toBe("Roadmap")
      expect(firstJson.suggestions).toHaveLength(3)
      expect(generateTextMock).toHaveBeenCalledTimes(1)

      const second = await GET(new Request(url))
      expect(second.status).toBe(200)
      const secondJson = await second.json()
      expect(secondJson.suggestions).toEqual(firstJson.suggestions)
      expect(generateTextMock).toHaveBeenCalledTimes(1)
    } finally {
      if (prevGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY
      else process.env.AI_GATEWAY_API_KEY = prevGatewayKey
      if (prevAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropicKey
    }
  })

  it("returns 200 with empty suggestions when checkAgentUsageLimit or the per-user sliding window denies", async () => {
    authMock.mockResolvedValue({ user: { id: "user-capped" } })
    prismaMock.workspace.findFirst.mockResolvedValue(workspaceRow)

    // 1. Daily turn cap reached
    prismaMock.agentMessage.aggregate.mockResolvedValueOnce({
      _count: { _all: 999 },
      _sum: { costUsd: 0 },
    })
    const cappedRes = await GET(
      new Request(
        `http://localhost/api/agent/page-suggestions?workspaceId=${WORKSPACE_ID}&pageUrl=${encodeURIComponent("/acme/compass/discovery")}`,
      ),
    )
    expect(cappedRes.status).toBe(200)
    const cappedBody = await cappedRes.json()
    expect(cappedBody.suggestions).toEqual([])
    expect(generateTextMock).not.toHaveBeenCalled()

    // 2. Sliding-window rate limit exhausted (30 uncached calls / 10m)
    const now = Date.now()
    for (let i = 0; i < USER_SUGGESTIONS_MAX_UNCACHED_CALLS; i++) {
      expect(consumePageSuggestionRateLimit("user-capped", now + i)).toBe(true)
    }
    expect(consumePageSuggestionRateLimit("user-capped", now + 100)).toBe(false)

    const rateLimitedRes = await GET(
      new Request(
        `http://localhost/api/agent/page-suggestions?workspaceId=${WORKSPACE_ID}&pageUrl=${encodeURIComponent("/acme/compass/tasks")}`,
      ),
    )
    expect(rateLimitedRes.status).toBe(200)
    const rateLimitedBody = await rateLimitedRes.json()
    expect(rateLimitedBody.suggestions).toEqual([])
    expect(generateTextMock).not.toHaveBeenCalled()
  })
})
