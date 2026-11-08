import { describe, expect, it, vi } from "vitest"
import { encrypt } from "@/lib/crypto-secrets"
import { resolveAgentModel } from "@/lib/agent-model"
import { resolveWorkspaceAgentModel } from "@/lib/workspace-anthropic-key"
import { AGENT_CREDENTIAL_SOURCES, agentRunCredentialSource, formatAgentRunCredentialSourceLine, logAgentRunCredentialSource, parseAgentCredentialSource } from "@/lib/agent-credential-source"

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

describe("the log line", () => {
  const cases: Array<[string, never, Record<string, string>, string]> = [
    ["platform", withoutByok(), { ANTHROPIC_API_KEY: PLATFORM }, "platform-api-key"],
    ["workspace", withByok(), { ANTHROPIC_API_KEY: PLATFORM }, "workspace-api-key"],
    ["bedrock", withoutByok(), { AGENT_MODEL_PROVIDER: "bedrock", BEDROCK_API_KEY: BEDROCK }, "bedrock"],
    ["subscription", withoutByok(), { AGENT_MODEL_PROVIDER: "claude-subscription", CLAUDE_CODE_OAUTH_TOKEN: OAUTH }, "claude-subscription"],
  ]

  it.each(cases)("the %s line is exactly the allowed shape and contains no key material", async (_name, db, env, label) => {
    const model = await resolveWorkspaceAgentModel(db, "ws-1", { SSO_SECRET_ENCRYPTION_KEY: ENC_KEY, ...env })
    if (!model.ok) throw new Error(model.message)
    const source = agentRunCredentialSource({ harness: "claude", model })
    expect(source).toBe(label)
    const line = formatAgentRunCredentialSourceLine({ runId: "run-1", workspaceId: "ws-1", source: source! })
    expect(line).toBe(`agent-run credential source=${label} runId=run-1 workspaceId=ws-1`)
    for (const secret of SECRETS) expect(line).not.toContain(secret)
  })

  it("opencode logs gateway; a failed resolution logs nothing", () => {
    expect(agentRunCredentialSource({ harness: "opencode", model: undefined })).toBe("gateway")
    expect(agentRunCredentialSource({ harness: "claude", model: undefined })).toBeNull()
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    logAgentRunCredentialSource({ runId: "r", workspaceId: "w", source: null })
    expect(info).not.toHaveBeenCalled()
    logAgentRunCredentialSource({ runId: "r", workspaceId: "w", source: "gateway" })
    expect(info).toHaveBeenCalledExactlyOnceWith("agent-run credential source=gateway runId=r workspaceId=w")
    info.mockRestore()
  })

  it("refuses to format a value outside the closed set (e.g. a key passed by mistake)", () => {
    expect(formatAgentRunCredentialSourceLine({ runId: "r", workspaceId: "w", source: BYOK as never })).toBeNull()
  })
})

describe("parsing", () => {
  it("parses only the closed set", () => {
    expect(parseAgentCredentialSource("bedrock")).toBe("bedrock")
    for (const bad of [null, undefined, 3, "", "sk-ant-api03-x", "Bedrock"]) expect(parseAgentCredentialSource(bad)).toBeNull()
    expect(AGENT_CREDENTIAL_SOURCES).toHaveLength(5)
  })
})
