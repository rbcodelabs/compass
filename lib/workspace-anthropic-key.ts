/**
 * Bring-your-own Anthropic API key (BYOK) for the in-app cloud agent (TASK-89).
 *
 * A workspace admin can store their own Anthropic API key. When one is stored, every agent run in that workspace uses it
 * (Anthropic API provider forced) instead of the deployment's platform key. The key is encrypted at rest with
 * lib/crypto-secrets.ts, exactly like Workspace.ssoSecretEncrypted. It is decrypted only server-side, only when a run is
 * built, and it is never returned to a client, logged or persisted in plaintext. Settings shows only the last four characters.
 *
 * Fail closed: a stored key that cannot be decrypted (missing or rotated SSO_SECRET_ENCRYPTION_KEY) refuses the run with a
 * message. It does NOT silently fall back to the platform key, because that would bill the platform for a workspace that
 * asked to pay for itself.
 */
import type { AppPrismaClient } from "@/lib/db"
import { decrypt, encrypt } from "@/lib/crypto-secrets"
import { DEFAULT_MODEL_IDS, resolveAgentModel, resolveProviderName, type ResolvedAgentModel } from "@/lib/agent-model"

/** Only Anthropic API keys (console.anthropic.com) are accepted. */
export const ANTHROPIC_KEY_PREFIX = "sk-ant-api"
/** Claude subscription OAuth tokens. Never accepted from or stored for a user: Anthropic's terms restrict them to personal use of Claude Code. */
const SUBSCRIPTION_TOKEN_PREFIX = "sk-ant-oat"
/** Anthropic keys are well under this; the cap only stops absurd input from reaching the cipher or the column. */
const MAX_KEY_LENGTH = 512
/** The encryption key env var is shared with the SSO secret (already provisioned wherever SSO works). */
export const ENCRYPTION_KEY_ENV = "SSO_SECRET_ENCRYPTION_KEY"

type Env = Record<string, string | undefined>
type WorkspaceDb = Pick<AppPrismaClient, "workspace">

export type ValidatedAnthropicKey = { ok: true; key: string; last4: string } | { ok: false; error: string }

/** Trims, then requires the `sk-ant-` prefix, no whitespace inside, and a sane length. The error never echoes the input. */
export function validateAnthropicApiKey(raw: unknown): ValidatedAnthropicKey {
  if (typeof raw !== "string") return { ok: false, error: "Enter an Anthropic API key." }
  const key = raw.trim()
  if (!key) return { ok: false, error: "Enter an Anthropic API key." }
  // Checked before the generic prefix so a pasted Claude subscription token gets the specific explanation.
  if (key.startsWith(SUBSCRIPTION_TOKEN_PREFIX)) {
    return { ok: false, error: "Claude subscription tokens (sk-ant-oat...) are not supported here. Enter an Anthropic API key (sk-ant-api...) from console.anthropic.com." }
  }
  if (!key.startsWith(ANTHROPIC_KEY_PREFIX)) return { ok: false, error: `An Anthropic API key starts with ${ANTHROPIC_KEY_PREFIX}.` }
  if (key.length <= ANTHROPIC_KEY_PREFIX.length || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
    return { ok: false, error: "That does not look like a valid Anthropic API key." }
  }
  return { ok: true, key, last4: key.slice(-4) }
}

/** Encrypts a validated key for storage. Throws when the server has no encryption key configured. */
export function encryptAnthropicApiKey(key: string, env: Env = process.env): string {
  const encryptionKey = env[ENCRYPTION_KEY_ENV]
  if (!encryptionKey) throw new Error(`${ENCRYPTION_KEY_ENV} is not configured on the server`)
  return encrypt(key, encryptionKey)
}

function isMissingColumn(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "P2021" || error.code === "P2022")
}

/** Reads one column. A deployment that has not applied migration 110 yet (P2022) simply has no BYOK key. */
async function readColumn(
  prisma: WorkspaceDb,
  workspaceId: string,
  column: "anthropicApiKeyEncrypted" | "anthropicApiKeyLast4",
): Promise<string | null> {
  try {
    const row = await prisma.workspace.findFirst({ where: { id: workspaceId }, select: { [column]: true } })
    return (row as Record<string, string | null> | null)?.[column] ?? null
  } catch (error) {
    if (isMissingColumn(error)) return null
    throw error
  }
}

/** The last four characters for Settings, or null when none is stored (or the migration is not applied). Never the key. */
export function readAnthropicKeyLast4(prisma: WorkspaceDb, workspaceId: string): Promise<string | null> {
  return readColumn(prisma, workspaceId, "anthropicApiKeyLast4")
}

export type WorkspaceAnthropicKey = { ok: true; key: string | null } | { ok: false; message: string }

/** Decrypts the workspace's BYOK key. `key: null` means none is stored. `ok: false` means one is stored but unusable. */
export async function loadWorkspaceAnthropicKey(prisma: WorkspaceDb, workspaceId: string, env: Env = process.env): Promise<WorkspaceAnthropicKey> {
  const ciphertext = await readColumn(prisma, workspaceId, "anthropicApiKeyEncrypted")
  if (!ciphertext) return { ok: true, key: null }
  const encryptionKey = env[ENCRYPTION_KEY_ENV]
  if (!encryptionKey) return { ok: false, message: "This workspace's Anthropic API key cannot be read because the server's encryption key is not configured." }
  try {
    return { ok: true, key: decrypt(ciphertext, encryptionKey) }
  } catch {
    // Deliberately no detail: the cause (wrong key, tampering) is not useful to the caller and nothing here may carry the secret.
    return { ok: false, message: "This workspace's stored Anthropic API key could not be decrypted. An admin must set it again in Settings." }
  }
}

/**
 * Precedence, in one place: a workspace key beats the platform key, and forces the Anthropic API provider even when the
 * deployment's AGENT_MODEL_PROVIDER is bedrock (a BYOK key is an Anthropic key and cannot authenticate to Bedrock). The model
 * id stays the deployment's AGENT_MODEL_ID only when the deployment's provider is not Bedrock; otherwise the Anthropic default
 * is used, since a Bedrock inference-profile id is not a valid Anthropic model name.
 */
export function modelFromWorkspaceKey(workspaceKey: string, env: Env = process.env): Extract<ResolvedAgentModel, { ok: true }> {
  const override = env.AGENT_MODEL_ID?.trim()
  const modelId = resolveProviderName(env) !== "bedrock" && override ? override : DEFAULT_MODEL_IDS.anthropic
  return { ok: true, provider: "anthropic", modelId, keyEnv: "ANTHROPIC_API_KEY", apiKey: workspaceKey, env }
}

/**
 * Drop-in for resolveAgentModel(env) at every place a Claude-harness run is started: the workspace's own key when it has one,
 * else the platform resolution unchanged. A workspace with a key never needs the platform key to be configured.
 */
export async function resolveWorkspaceAgentModel(prisma: WorkspaceDb, workspaceId: string, env: Env = process.env): Promise<ResolvedAgentModel> {
  const stored = await loadWorkspaceAnthropicKey(prisma, workspaceId, env)
  if (!stored.ok) return { ok: false, message: stored.message }
  return stored.key ? modelFromWorkspaceKey(stored.key, env) : resolveAgentModel(env)
}
