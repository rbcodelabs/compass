/**
 * Session wiring in the agent turn route (app/api/agent/turn/route.ts).
 *
 * The session store itself is covered in agent-session.test.ts; this file pins what the
 * route does with a plan: which env/files reach the sandbox, that the synchronous path
 * commits the transcript before telling the browser it is done, that a commit failure
 * never fails the turn, and that machine-driven handoff turns never touch sessions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockPrisma = {
  workspace: { findFirst: vi.fn() },
  agentConversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  agentMessage: { create: vi.fn(), findMany: vi.fn() },
  agentAuditLog: { createMany: vi.fn() },
  workspaceCapabilityPack: { findMany: vi.fn() },
  // Agent features are always on, so every turn consults the stored agent defaults (none here).
  userDefaultAgent: { findFirst: vi.fn().mockResolvedValue(null) },
  workspaceDefaultAgent: { findFirst: vi.fn().mockResolvedValue(null) },
  // ADR 0019: the route materializes the doc tree (via lib/doc-fs.ts) before every turn.
  doc: { findMany: vi.fn(), findUnique: vi.fn() },
}
Object.assign(mockPrisma, { $transaction: <T>(fn: (tx: typeof mockPrisma) => Promise<T>) => fn(mockPrisma) })
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

vi.mock("@/lib/agent-runtime-config", () => ({ getGoldenSnapshotId: () => Promise.resolve("snap_abc") }))
const mockBootSandbox = vi.fn()
vi.mock("@/lib/agent-sandbox", () => ({ bootSandboxFromSnapshot: (id: string) => mockBootSandbox(id) }))
vi.mock("@/lib/agent-mcp-key", () => ({
  mintAgentMcpKey: vi.fn().mockResolvedValue({ token: "tok", apiKeyId: "key-1" }),
  revokeAgentMcpKey: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/capability-pack-runtime", () => ({
  prepareCapabilityPacksForTurn: vi.fn().mockResolvedValue({ files: [], pluginPaths: [], skillIds: [], provenanceJson: "[]", systemPromptAppendices: [] }),
}))
vi.mock("@/lib/artifact-storage", () => ({ getCapabilityPackArtifactStorage: () => ({}) }))
vi.mock("@/lib/agent-limits", async (original) => ({ ...await original<object>(), checkAgentUsageLimit: () => Promise.resolve({ allowed: true }), checkAgentRunCaps: () => Promise.resolve({ allowed: true }) }))
vi.mock("@/lib/agent-context", () => ({ resolveAgentHandoffContext: vi.fn().mockResolvedValue(null) }))
vi.mock("@/lib/entity-summary", () => ({ getEntitySummary: vi.fn().mockResolvedValue(null) }))
vi.mock("@/lib/mcp-connectors/store", () => ({ listConnectedGrants: vi.fn().mockResolvedValue([]) }))

const runMocks = vi.hoisted(() => ({ available: vi.fn(), create: vi.fn(), started: vi.fn(), finalize: vi.fn() }))
vi.mock("@/lib/agent-runs", async (original) => ({
  ...(await original<object>()),
  agentRunsAvailable: runMocks.available,
  createAgentRun: runMocks.create,
  markAgentRunStarted: runMocks.started,
  finalizeAgentRun: runMocks.finalize,
}))

const sessionMocks = vi.hoisted(() => ({ plan: vi.fn(), commit: vi.fn() }))
vi.mock("@/lib/agent-session", async (original) => ({
  ...(await original<object>()),
  planAgentSession: sessionMocks.plan,
  commitAgentSession: sessionMocks.commit,
}))

import { POST } from "@/app/api/agent/turn/route"

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const RUN = { id: "11111111-1111-4111-8111-111111111111", deadlineAt: new Date("2026-09-25T12:34:56.000Z") }

const req = (body: unknown) =>
  new NextRequest("https://compass.rbcodelabs.com/api/agent/turn", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })

const resumePlan = (gap: { role: "user" | "assistant"; content: string }[] = []) => ({
  enabled: true as const,
  sessionId: SESSION_ID,
  resume: { bytes: new Uint8Array([0x1f, 0x8b, 1, 2, 3]), gap },
})
const freshPlan = { enabled: true as const, sessionId: SESSION_ID, resume: null }

function stream(lines: string[], exitCode = 0) {
  return {
    logs: async function* () {
      for (const line of lines) yield { stream: "stdout", data: `${line}\n` }
    },
    wait: async () => ({ exitCode }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = "sk-ant-test"
  delete process.env.AGENT_MODEL_PROVIDER
  delete process.env.AGENT_MODEL_ID
  delete process.env.BEDROCK_API_KEY
  delete process.env.AWS_REGION
  mockAuth.mockResolvedValue({ user: { id: "user-1" } })
  mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws-1", name: "Acme", slug: "acme", organization: { slug: "org" } })
  mockPrisma.agentConversation.findFirst.mockResolvedValue(null)
  mockPrisma.agentConversation.create.mockResolvedValue({ id: "c-1" })
  mockPrisma.agentConversation.update.mockResolvedValue({ id: "c-1" })
  mockPrisma.workspaceCapabilityPack.findMany.mockResolvedValue([])
  mockPrisma.agentMessage.create.mockResolvedValue({ id: "user-msg-1" })
  mockPrisma.agentMessage.findMany.mockResolvedValue([])
  runMocks.available.mockResolvedValue(false)
  mockPrisma.doc.findMany.mockResolvedValue([])
  process.env.AUTH_SECRET = "test-auth-secret"
  runMocks.started.mockResolvedValue(undefined)
  sessionMocks.commit.mockResolvedValue({ committed: true, revision: 1 })
})

describe("synchronous path", () => {
  function sandbox(run: unknown, out: Uint8Array | null = new Uint8Array([0x1f, 0x8b, 9])) {
    const writeFiles = vi.fn().mockResolvedValue(undefined)
    const runCommand = vi.fn().mockResolvedValue(run)
    const readFileToBuffer = vi.fn().mockResolvedValue(out ? Buffer.from(out) : null)
    mockBootSandbox.mockResolvedValue({ writeFiles, runCommand, readFileToBuffer, stop: vi.fn().mockResolvedValue(undefined) })
    return { writeFiles, runCommand, readFileToBuffer }
  }
  const ok = [`AGENT_SESSION ${JSON.stringify({ sessionId: SESSION_ID })}`, `AGENT_RESULT ${JSON.stringify({ text: "done" })}`]

  it("resumes: ships the transcript and fallback prompt, and sends only the new message", async () => {
    sessionMocks.plan.mockResolvedValue(resumePlan([{ role: "user", content: "earlier failed turn" }]))
    const { writeFiles, runCommand } = sandbox(stream(ok))
    await (await POST(req({ workspaceId: "ws-1", message: "and now?" }))).text()

    const paths = (writeFiles.mock.calls[0][0] as { path: string }[]).map((f) => f.path)
    expect(paths).toEqual(expect.arrayContaining(["entry.ts", "session-in.jsonl.gz", "fallback-prompt.txt"]))
    const env = runCommand.mock.calls[0][0].env
    expect(env.AGENT_SESSION_ID).toBe(SESSION_ID)
    expect(env.AGENT_SESSION_MODE).toBe("resume")
    expect(env.AGENT_PROMPT).toContain("User: and now?")
    expect(env.AGENT_PROMPT).toContain("earlier failed turn")
  })

  it("starts a new session with no transcript files when there is nothing to resume", async () => {
    sessionMocks.plan.mockResolvedValue(freshPlan)
    const { writeFiles, runCommand } = sandbox(stream(ok))
    await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()

    const paths = (writeFiles.mock.calls[0][0] as { path: string }[]).map((f) => f.path)
    expect(paths).not.toContain("session-in.jsonl.gz")
    expect(runCommand.mock.calls[0][0].env).toMatchObject({ AGENT_SESSION_ID: SESSION_ID, AGENT_SESSION_MODE: "new" })
  })

  it("sets no session env at all when sessions are disabled", async () => {
    sessionMocks.plan.mockResolvedValue({ enabled: false })
    const { runCommand } = sandbox(stream([`AGENT_RESULT ${JSON.stringify({ text: "done" })}`]))
    await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()

    const env = runCommand.mock.calls[0][0].env
    expect(env).not.toHaveProperty("AGENT_SESSION_ID")
    expect(env).not.toHaveProperty("AGENT_SESSION_MODE")
    expect(sessionMocks.commit).not.toHaveBeenCalled()
  })

  it("commits the transcript against the user's message, before the result event", async () => {
    sessionMocks.plan.mockResolvedValue(freshPlan)
    sandbox(stream(ok))
    const body = await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()

    expect(sessionMocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c-1", workspaceId: "ws-1", sessionId: SESSION_ID, throughMessageId: "user-msg-1" }),
    )
    expect(body).toContain("event: result")
  })

  it("commits the session id the agent reported, not the planned one, when they differ", async () => {
    const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    sessionMocks.plan.mockResolvedValue(resumePlan())
    sandbox(stream([`AGENT_SESSION ${JSON.stringify({ sessionId: other })}`, `AGENT_RESULT ${JSON.stringify({ text: "done" })}`]))
    await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()
    expect(sessionMocks.commit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: other }))
  })

  it("does not commit when the agent never reported a session (e.g. the SDK failed first)", async () => {
    sessionMocks.plan.mockResolvedValue(freshPlan)
    sandbox(stream([`AGENT_RESULT ${JSON.stringify({ text: "done" })}`]))
    await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()
    expect(sessionMocks.commit).not.toHaveBeenCalled()
  })

  it("ignores a malformed session id from the sandbox", async () => {
    sessionMocks.plan.mockResolvedValue(freshPlan)
    sandbox(stream([`AGENT_SESSION ${JSON.stringify({ sessionId: "../../x" })}`, `AGENT_RESULT ${JSON.stringify({ text: "done" })}`]))
    await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()
    expect(sessionMocks.commit).not.toHaveBeenCalled()
  })

  it("still delivers the answer when saving the session throws", async () => {
    sessionMocks.plan.mockResolvedValue(freshPlan)
    sessionMocks.commit.mockRejectedValue(new Error("blob down"))
    vi.spyOn(console, "warn").mockImplementation(() => {})
    sandbox(stream(ok))
    const body = await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()
    expect(body).toContain("event: result")
    expect(body).not.toContain("event: error")
  })

  it("still delivers the answer when the transcript file cannot be read", async () => {
    sessionMocks.plan.mockResolvedValue(freshPlan)
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { readFileToBuffer } = sandbox(stream(ok))
    readFileToBuffer.mockRejectedValue(new Error("no such file"))
    const body = await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()
    expect(body).toContain("event: result")
    expect(sessionMocks.commit).not.toHaveBeenCalled()
  })

  it("does not plan a session for a claimed handoff/interview turn", async () => {
    mockPrisma.agentConversation.findFirst.mockResolvedValue({
      id: "c-1",
      interviewProcessingJson: JSON.stringify({ status: "PENDING", interviewId: "interview" }),
    })
    mockPrisma.agentConversation.updateMany.mockResolvedValue({ count: 1 })
    const { runCommand } = sandbox(stream([`AGENT_RESULT ${JSON.stringify({ text: "done" })}`]))
    await (await POST(req({ workspaceId: "ws-1", conversationId: "c-1", message: "Finish interview" }))).text()

    expect(sessionMocks.plan).not.toHaveBeenCalled()
    expect(sessionMocks.commit).not.toHaveBeenCalled()
    expect(runCommand.mock.calls[0][0].env).not.toHaveProperty("AGENT_SESSION_ID")
  })
})

describe("page context (agent rail)", () => {
  const ok = [`AGENT_RESULT ${JSON.stringify({ text: "done" })}`]
  function run() {
    const runCommand = vi.fn().mockResolvedValue(stream(ok))
    mockBootSandbox.mockResolvedValue({
      writeFiles: vi.fn().mockResolvedValue(undefined),
      runCommand,
      readFileToBuffer: vi.fn().mockResolvedValue(null),
      stop: vi.fn().mockResolvedValue(undefined),
    })
    return runCommand
  }

  it("folds the page the rail is on into a new-session prompt, before the user message", async () => {
    sessionMocks.plan.mockResolvedValue({ enabled: false })
    const runCommand = run()
    await (await POST(req({ workspaceId: "ws-1", message: "what is this?", pageUrl: "/org/acme/roadmap" }))).text()

    const prompt: string = runCommand.mock.calls[0][0].env.AGENT_PROMPT
    expect(prompt).toContain("### Where the user is right now")
    expect(prompt).toContain("Section: Roadmap")
    expect(prompt.indexOf("Where the user is right now")).toBeLessThan(prompt.indexOf("User: what is this?"))
  })

  it("restates it on a resumed turn, and in the fallback prompt", async () => {
    sessionMocks.plan.mockResolvedValue({
      enabled: true as const,
      sessionId: SESSION_ID,
      resume: { bytes: new Uint8Array([0x1f, 0x8b, 1]), gap: [] },
    })
    const writeFiles = vi.fn().mockResolvedValue(undefined)
    const runCommand = vi.fn().mockResolvedValue(stream(ok))
    mockBootSandbox.mockResolvedValue({ writeFiles, runCommand, readFileToBuffer: vi.fn().mockResolvedValue(null), stop: vi.fn() })
    await (await POST(req({ workspaceId: "ws-1", message: "and here?", pageUrl: "/org/acme/okrs" }))).text()

    const env = runCommand.mock.calls[0][0].env
    expect(env.AGENT_PROMPT).toContain("Section: OKRs")
    expect(env.AGENT_PROMPT).toContain("User: and here?")
    const files = writeFiles.mock.calls[0][0] as { path: string; content: Buffer }[]
    const fallback = files.find((f) => f.path === "fallback-prompt.txt")!.content.toString("utf8")
    expect(fallback).toContain("Section: OKRs")
  })

  it("adds nothing when the client sent no pageUrl (the full-page agent screen)", async () => {
    sessionMocks.plan.mockResolvedValue({ enabled: false })
    const runCommand = run()
    await (await POST(req({ workspaceId: "ws-1", message: "hi" }))).text()
    expect(runCommand.mock.calls[0][0].env.AGENT_PROMPT).not.toContain("Where the user is right now")
  })

  it("ignores a pageUrl that names a different workspace", async () => {
    sessionMocks.plan.mockResolvedValue({ enabled: false })
    const runCommand = run()
    await (await POST(req({ workspaceId: "ws-1", message: "hi", pageUrl: "/org/someone-elses/roadmap" }))).text()
    expect(runCommand.mock.calls[0][0].env.AGENT_PROMPT).not.toContain("Where the user is right now")
  })

  it("never persists the block as a chat message", async () => {
    sessionMocks.plan.mockResolvedValue({ enabled: false })
    run()
    await (await POST(req({ workspaceId: "ws-1", message: "hi", pageUrl: "/org/acme/roadmap" }))).text()
    expect(mockPrisma.agentMessage.create.mock.calls[0][0].data.content).toBe("hi")
  })
})

describe("detached path", () => {
  beforeEach(() => {
    runMocks.available.mockResolvedValue(true)
    runMocks.create.mockResolvedValue({ run: RUN, workerToken: "w".repeat(43), sandboxName: `compass-agent-run-${RUN.id}` })
  })

  it("hands the worker the same session env and files, and does not commit from the request", async () => {
    sessionMocks.plan.mockResolvedValue(resumePlan())
    const writeFiles = vi.fn().mockResolvedValue(undefined)
    const runCommand = vi.fn().mockResolvedValue({})
    mockBootSandbox.mockResolvedValue({ writeFiles, runCommand, stop: vi.fn() })

    const response = await POST(req({ workspaceId: "ws-1", message: "hi" }))
    expect(response.status).toBe(202)

    const paths = (writeFiles.mock.calls[0][0] as { path: string }[]).map((f) => f.path)
    expect(paths).toEqual(expect.arrayContaining(["session-in.jsonl.gz", "fallback-prompt.txt"]))
    expect(runCommand.mock.calls[0][0].env).toMatchObject({ AGENT_SESSION_ID: SESSION_ID, AGENT_SESSION_MODE: "resume" })
    // The worker uploads itself (bound to its run token); the request has nothing to commit.
    expect(sessionMocks.commit).not.toHaveBeenCalled()
  })
})
