import { describe, expect, it, vi } from "vitest"
import { decrypt, encrypt } from "@/lib/crypto-secrets"
import { buildAgentEnv } from "@/lib/agent-run-sandbox"
import { agentEgressPolicy } from "@/lib/agent-github-access"
import {
  encryptAnthropicApiKey,
  loadWorkspaceAnthropicKey,
  readAnthropicKeyLast4,
  resolveWorkspaceAgentModel,
  validateAnthropicApiKey,
} from "@/lib/workspace-anthropic-key"

const KEY = Buffer.alloc(32, 3).toString("base64")
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64")
const BYOK = "sk-ant-api03-customer-key-1234"
const PLATFORM = "sk-ant-platform-key-9999"

function dbWith(row: Record<string, string | null> | null) {
  return { workspace: { findFirst: vi.fn(async () => row) } } as never
}
const base = { connectors: [], mcpBaseUrl: "https://compass.test", mcpToken: "t", prompt: "hi", workspaceId: "ws-1", systemPromptAppendices: [], pluginPaths: [], skillIds: [] }

describe("validateAnthropicApiKey", () => {
  it("accepts sk-ant- keys, trims, and reports the last four", () => {
    expect(validateAnthropicApiKey(`  ${BYOK}\n`)).toEqual({ ok: true, key: BYOK, last4: "1234" })
  })
  it("rejects a Claude subscription OAuth token with an explicit message, and never echoes it", () => {
    const token = "sk-ant-oat01-subscription-token-abcdef"
    const result = validateAnthropicApiKey(token)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/subscription tokens/i)
      expect(result.error).toMatch(/not supported/i)
      expect(result.error).not.toContain(token)
    }
  })
  it("rejects other sk-ant- credentials that are not API keys (e.g. admin keys)", () => {
    expect(validateAnthropicApiKey("sk-ant-admin01-abcdefgh").ok).toBe(false)
  })
  it.each([["", "empty"], ["sk-proj-abcdefgh", "wrong prefix"], ["sk-ant-api", "prefix only"], ["sk-ant-abcdefgh", "sk-ant- but not api"], ["sk-ant-a b", "whitespace"], ["sk-ant-" + "x".repeat(600), "too long"], [42, "not a string"], [null, "null"]])(
    "rejects %s (%s)",
    (input: unknown, _why?: string) => {
      const result = validateAnthropicApiKey(input)
      expect(result.ok).toBe(false)
      if (!result.ok && typeof input === "string") expect(result.error).not.toContain(input.trim() || "\0")
    },
  )
})

describe("encryption round-trip", () => {
  it("round-trips and does not store the plaintext", () => {
    const ciphertext = encryptAnthropicApiKey(BYOK, { SSO_SECRET_ENCRYPTION_KEY: KEY })
    expect(ciphertext).not.toContain(BYOK)
    expect(Buffer.from(ciphertext, "base64").toString("utf8")).not.toContain(BYOK)
    expect(decrypt(ciphertext, KEY)).toBe(BYOK)
  })
  it("uses a fresh nonce each time", () => {
    const env = { SSO_SECRET_ENCRYPTION_KEY: KEY }
    expect(encryptAnthropicApiKey(BYOK, env)).not.toBe(encryptAnthropicApiKey(BYOK, env))
  })
  it("fails to decrypt under another key or when tampered", () => {
    const ciphertext = encrypt(BYOK, KEY)
    expect(() => decrypt(ciphertext, OTHER_KEY)).toThrow()
    const raw = Buffer.from(ciphertext, "base64")
    raw[raw.length - 1] ^= 1
    expect(() => decrypt(raw.toString("base64"), KEY)).toThrow()
  })
  it("refuses to encrypt without a server key", () => {
    expect(() => encryptAnthropicApiKey(BYOK, {})).toThrow(/SSO_SECRET_ENCRYPTION_KEY/)
  })
})

describe("loadWorkspaceAnthropicKey", () => {
  it("returns null key when none is stored", async () => {
    expect(await loadWorkspaceAnthropicKey(dbWith({ anthropicApiKeyEncrypted: null }), "ws-1", { SSO_SECRET_ENCRYPTION_KEY: KEY })).toEqual({ ok: true, key: null })
    expect(await loadWorkspaceAnthropicKey(dbWith(null), "ws-1", { SSO_SECRET_ENCRYPTION_KEY: KEY })).toEqual({ ok: true, key: null })
  })
  it("decrypts a stored key", async () => {
    const db = dbWith({ anthropicApiKeyEncrypted: encrypt(BYOK, KEY) })
    expect(await loadWorkspaceAnthropicKey(db, "ws-1", { SSO_SECRET_ENCRYPTION_KEY: KEY })).toEqual({ ok: true, key: BYOK })
  })
  it("fails closed, without the secret in the message, when the key was encrypted under another server key", async () => {
    const db = dbWith({ anthropicApiKeyEncrypted: encrypt(BYOK, KEY) })
    const result = await loadWorkspaceAnthropicKey(db, "ws-1", { SSO_SECRET_ENCRYPTION_KEY: OTHER_KEY })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(BYOK)
  })
  it("fails closed when a key is stored but the server has no encryption key", async () => {
    const db = dbWith({ anthropicApiKeyEncrypted: encrypt(BYOK, KEY) })
    expect((await loadWorkspaceAnthropicKey(db, "ws-1", {})).ok).toBe(false)
  })
  it("treats an unapplied migration (P2022) as no key, but rethrows real faults", async () => {
    const missing = { workspace: { findFirst: vi.fn().mockRejectedValue(Object.assign(new Error("col"), { code: "P2022" })) } } as never
    expect(await loadWorkspaceAnthropicKey(missing, "ws-1", { SSO_SECRET_ENCRYPTION_KEY: KEY })).toEqual({ ok: true, key: null })
    expect(await readAnthropicKeyLast4(missing, "ws-1")).toBeNull()
    const broken = { workspace: { findFirst: vi.fn().mockRejectedValue(new Error("connection reset")) } } as never
    await expect(loadWorkspaceAnthropicKey(broken, "ws-1", { SSO_SECRET_ENCRYPTION_KEY: KEY })).rejects.toThrow("connection reset")
  })
})

describe("env injection precedence (resolveWorkspaceAgentModel -> buildAgentEnv)", () => {
  const stored = () => dbWith({ anthropicApiKeyEncrypted: encrypt(BYOK, KEY) })
  const none = () => dbWith({ anthropicApiKeyEncrypted: null })

  async function envFor(db: never, env: Record<string, string>) {
    const model = await resolveWorkspaceAgentModel(db, "ws-1", env)
    if (!model.ok) throw new Error(model.message)
    return buildAgentEnv({ ...base, harness: "claude", model })
  }

  it("a workspace key wins over the platform ANTHROPIC_API_KEY", async () => {
    const out = await envFor(stored(), { SSO_SECRET_ENCRYPTION_KEY: KEY, ANTHROPIC_API_KEY: PLATFORM })
    expect(out.ANTHROPIC_API_KEY).toBe(BYOK)
    expect(JSON.stringify(out)).not.toContain(PLATFORM)
  })

  it("without a workspace key the platform key is used, unchanged", async () => {
    const out = await envFor(none(), { SSO_SECRET_ENCRYPTION_KEY: KEY, ANTHROPIC_API_KEY: PLATFORM })
    expect(out.ANTHROPIC_API_KEY).toBe(PLATFORM)
    expect(out.AGENT_MODEL).toBe("claude-sonnet-5")
  })

  it("forces the Anthropic provider when the platform is on Bedrock: no Bedrock credential or switch, Anthropic model id", async () => {
    const out = await envFor(stored(), { SSO_SECRET_ENCRYPTION_KEY: KEY, AGENT_MODEL_PROVIDER: "bedrock", BEDROCK_API_KEY: "bedrock-secret", AGENT_MODEL_ID: "global.anthropic.claude-x" })
    expect(out.ANTHROPIC_API_KEY).toBe(BYOK)
    expect(out.AGENT_MODEL).toBe("claude-sonnet-5")
    expect(out).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK")
    expect(out).not.toHaveProperty("AWS_BEARER_TOKEN_BEDROCK")
    expect(JSON.stringify(out)).not.toContain("bedrock-secret")
  })

  it("a workspace key works even when the platform has no key configured", async () => {
    const out = await envFor(stored(), { SSO_SECRET_ENCRYPTION_KEY: KEY })
    expect(out.ANTHROPIC_API_KEY).toBe(BYOK)
  })

  it("keeps the deployment's AGENT_MODEL_ID when the platform provider is anthropic", async () => {
    const out = await envFor(stored(), { SSO_SECRET_ENCRYPTION_KEY: KEY, ANTHROPIC_API_KEY: PLATFORM, AGENT_MODEL_ID: "claude-opus-9" })
    expect(out.AGENT_MODEL).toBe("claude-opus-9")
  })

  it("an undecryptable stored key refuses the run instead of falling back to the platform key", async () => {
    const result = await resolveWorkspaceAgentModel(stored(), "ws-1", { SSO_SECRET_ENCRYPTION_KEY: OTHER_KEY, ANTHROPIC_API_KEY: PLATFORM })
    expect(result.ok).toBe(false)
  })

  it("with no workspace key and no platform key the platform error is unchanged", async () => {
    const result = await resolveWorkspaceAgentModel(none(), "ws-1", {})
    expect(result).toEqual({ ok: false, message: "ANTHROPIC_API_KEY is not configured on this deployment." })
  })

  it("the opencode harness never receives the workspace key", () => {
    const out = buildAgentEnv({ ...base, harness: "opencode", gatewayApiKey: "g" })
    expect(out).not.toHaveProperty("ANTHROPIC_API_KEY")
  })

  it("egress policy allows api.anthropic.com (not Bedrock) for a BYOK run on a Bedrock deployment", async () => {
    const model = await resolveWorkspaceAgentModel(stored(), "ws-1", { SSO_SECRET_ENCRYPTION_KEY: KEY, AGENT_MODEL_PROVIDER: "bedrock", BEDROCK_API_KEY: "b" })
    if (!model.ok) throw new Error(model.message)
    const hosts = (agentEgressPolicy({ mcpBaseUrl: "https://compass.test", model }) as { allow: string[] }).allow
    expect(hosts).toContain("api.anthropic.com")
    expect(hosts.some((h) => h.startsWith("bedrock-runtime"))).toBe(false)
  })
})
