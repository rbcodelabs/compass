import { beforeEach, describe, expect, it, vi } from "vitest"
import { encrypt } from "@/lib/crypto-secrets"
import { resolveAgentModel } from "@/lib/agent-model"
import { resolveWorkspaceAgentModel } from "@/lib/workspace-anthropic-key"
import { AGENT_CREDENTIAL_SOURCES, agentCredentialSourceLabel, parseAgentCredentialSource } from "@/lib/agent-credential-source"
import { agentRunCredentialSourceAvailable, createAgentRun, resetAgentRunCredentialSourceAvailabilityCache } from "@/lib/agent-runs"
import { serializeAgentRun } from "@/lib/agent-run-view"

const ENC_KEY = Buffer.alloc(32, 3).toString("base64")
const BYOK = "sk-ant-api03-customer-key-1234"
const PLATFORM = "sk-ant-platform-key-9999"
const BEDROCK = "bedrock-bearer-secret-5555"
const OAUTH = "sk-ant-oat01-subscription-secret-7777"
const SECRETS = [BYOK, PLATFORM, BEDROCK, OAUTH, "1234"]

function dbWith(row: Record<string, string | null> | null) {
  return { workspace: { findFirst: vi.fn(async () => row) } } as never
}
const withByok = () => dbWith({ anthropicApiKeyEncrypted: encrypt(BYOK, ENC_KEY) })
const withoutByok = () => dbWith({ anthropicApiKeyEncrypted: null })

async function sourceFor(db: never, env: Record<string, string>) {
  const model = await resolveWorkspaceAgentModel(db, "ws-1", { SSO_SECRET_ENCRYPTION_KEY: ENC_KEY, ...env })
  if (!model.ok) throw new Error(model.message)
  return model.credentialSource
}

describe("credential source derivation", () => {
  it("platform Anthropic key -> platform-api-key (the default provider)", async () => {
    expect(await sourceFor(withoutByok(), { ANTHROPIC_API_KEY: PLATFORM })).toBe("platform-api-key")
    expect(resolveAgentModel({ ANTHROPIC_API_KEY: PLATFORM })).toMatchObject({ ok: true, credentialSource: "platform-api-key" })
  })

  it("workspace BYOK key -> workspace-api-key, even over a platform key", async () => {
    expect(await sourceFor(withByok(), { ANTHROPIC_API_KEY: PLATFORM })).toBe("workspace-api-key")
    expect(await sourceFor(withByok(), {})).toBe("workspace-api-key")
  })

  it("workspace BYOK key on a Bedrock deployment -> workspace-api-key (provider is forced to Anthropic)", async () => {
    expect(await sourceFor(withByok(), { AGENT_MODEL_PROVIDER: "bedrock", BEDROCK_API_KEY: BEDROCK })).toBe("workspace-api-key")
  })

  it("Bedrock provider -> bedrock", async () => {
    expect(await sourceFor(withoutByok(), { AGENT_MODEL_PROVIDER: "bedrock", BEDROCK_API_KEY: BEDROCK })).toBe("bedrock")
  })

  it("operator claude-subscription provider -> claude-subscription", async () => {
    expect(await sourceFor(withoutByok(), { AGENT_MODEL_PROVIDER: "claude-subscription", CLAUDE_CODE_OAUTH_TOKEN: OAUTH })).toBe("claude-subscription")
  })

  it("a failed resolution carries no source", async () => {
    const result = await resolveWorkspaceAgentModel(withoutByok(), "ws-1", {})
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty("credentialSource")
  })
})

describe("no secret reaches the persisted or displayed value", () => {
  const cases: Array<[string, never, Record<string, string>]> = [
    ["platform", withoutByok(), { ANTHROPIC_API_KEY: PLATFORM }],
    ["workspace", withByok(), { ANTHROPIC_API_KEY: PLATFORM }],
    ["bedrock", withoutByok(), { AGENT_MODEL_PROVIDER: "bedrock", BEDROCK_API_KEY: BEDROCK }],
    ["subscription", withoutByok(), { AGENT_MODEL_PROVIDER: "claude-subscription", CLAUDE_CODE_OAUTH_TOKEN: OAUTH }],
  ]

  it.each(cases)("the %s source is a closed label containing no key material", async (_name, db, env) => {
    const source = await sourceFor(db, env)
    expect(AGENT_CREDENTIAL_SOURCES).toContain(source)
    for (const secret of SECRETS) expect(`${source}|${agentCredentialSourceLabel(source)}`).not.toContain(secret)
  })

  it("createAgentRun writes only the closed label to the column, and the full create payload never carries a key", async () => {
    resetAgentRunCredentialSourceAvailabilityCache()
    const create = vi.fn(({ data }: { data: unknown }) => Promise.resolve(data))
    const prisma = {
      agentRun: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), create },
      agentConversation: { updateMany: vi.fn() },
    } as never as Parameters<typeof createAgentRun>[0]["prisma"]
    ;(prisma as unknown as { $transaction: unknown }).$transaction = (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)
    const source = await sourceFor(withByok(), {})
    await createAgentRun({ prisma, conversationId: "c-1", workspaceId: "ws-1", userId: "u-1", credentialSource: source })
    const data = create.mock.calls[0][0].data as Record<string, unknown>
    expect(data.credentialSource).toBe("workspace-api-key")
    for (const secret of SECRETS) expect(JSON.stringify(data)).not.toContain(secret)
  })

  it("an unknown or secret-looking stored value is never serialized to the client", () => {
    const base = { id: "r", conversationId: "c", workspaceId: "w", status: "RUNNING", kind: "CHAT", lastSeq: 0, eventCount: 0, deadlineAt: new Date(0), createdAt: new Date(0) }
    expect(serializeAgentRun({ ...base, credentialSource: BYOK }).credentialSource).toBeNull()
    expect(JSON.stringify(serializeAgentRun({ ...base, credentialSource: BYOK }))).not.toContain(BYOK)
    expect(serializeAgentRun({ ...base, credentialSource: "bedrock" }).credentialSource).toBe("bedrock")
    expect(serializeAgentRun(base).credentialSource).toBeNull()
  })

  it("createAgentRun refuses to persist a value outside the closed set", async () => {
    resetAgentRunCredentialSourceAvailabilityCache()
    const create = vi.fn(({ data }: { data: unknown }) => Promise.resolve(data))
    const prisma = { agentRun: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), create }, agentConversation: { updateMany: vi.fn() } } as never as Parameters<typeof createAgentRun>[0]["prisma"]
    ;(prisma as unknown as { $transaction: unknown }).$transaction = (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)
    await createAgentRun({ prisma, conversationId: "c-1", workspaceId: "ws-1", userId: "u-1", credentialSource: BYOK as never })
    expect(create.mock.calls[0][0].data).not.toHaveProperty("credentialSource")
  })
})

describe("labels and parsing", () => {
  it("maps each source to its display label", () => {
    expect(agentCredentialSourceLabel("platform-api-key")).toBe("Platform API key")
    expect(agentCredentialSourceLabel("workspace-api-key")).toBe("Workspace API key")
    expect(agentCredentialSourceLabel("claude-subscription")).toBe("Claude subscription")
    expect(agentCredentialSourceLabel("bedrock")).toBe("Bedrock")
    expect(agentCredentialSourceLabel("gateway")).toBe("AI Gateway")
  })

  it("parses only the closed set", () => {
    expect(parseAgentCredentialSource("bedrock")).toBe("bedrock")
    for (const bad of [null, undefined, 3, "", "sk-ant-api03-x", "Bedrock"]) expect(parseAgentCredentialSource(bad)).toBeNull()
  })
})

describe("migration 111 tolerance", () => {
  beforeEach(() => resetAgentRunCredentialSourceAvailabilityCache())

  it("probe is false on a missing column (P2022) and createAgentRun then omits the column instead of failing", async () => {
    const create = vi.fn(({ data }: { data: unknown }) => Promise.resolve(data))
    const prisma = {
      agentRun: { findMany: vi.fn().mockRejectedValue({ code: "P2022" }), findFirst: vi.fn().mockResolvedValue(null), create },
      agentConversation: { updateMany: vi.fn() },
    } as never as Parameters<typeof createAgentRun>[0]["prisma"]
    ;(prisma as unknown as { $transaction: unknown }).$transaction = (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)
    expect(await agentRunCredentialSourceAvailable(prisma)).toBe(false)
    await createAgentRun({ prisma, conversationId: "c-1", workspaceId: "ws-1", userId: "u-1", credentialSource: "bedrock" })
    expect(create.mock.calls[0][0].data).not.toHaveProperty("credentialSource")
  })

  it("a non-schema error is surfaced, not swallowed", async () => {
    const prisma = { agentRun: { findMany: vi.fn().mockRejectedValue(new Error("connection reset")) } } as never as Parameters<typeof agentRunCredentialSourceAvailable>[0]
    await expect(agentRunCredentialSourceAvailable(prisma)).rejects.toThrow("connection reset")
  })
})
