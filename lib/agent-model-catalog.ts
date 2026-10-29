/**
 * The Vercel AI Gateway model catalog, offered to agent managers when they pick a cloud agent's model.
 *
 * Source: the gateway's public listing (no credential, nothing secret is sent). Only language models that advertise
 * `tool-use` are kept, because an agent run is a tool-calling loop. The fetch is cached by Next for an hour and bounded by a
 * short timeout; on ANY failure this module answers "no catalog" and callers fall back to the curated list in
 * lib/agent-models.ts. Nothing here ever throws to the UI.
 *
 * Harness gate: lib/agent-harness.ts (agentModelForHarness) only honours `provider/model` references on the opencode
 * harness, and the Claude harness only serves Claude ids, so the catalog is offered and accepted ONLY when the deployment
 * runs opencode. Validation is server-side against a fresh read of the catalog; the client's list is never trusted.
 *
 * Scope: agent setup only. The chat's per-message Model menu (lib/agent-turn-model.ts) stays on the curated allowlist.
 */
import { resolveAgentHarness } from "@/lib/agent-harness"
import { allowedAgentModels, MODEL_SHAPE, parseAgentModel, type AgentModelOption } from "@/lib/agent-models"

export const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models"
const REVALIDATE_SECONDS = 3600
const TIMEOUT_MS = 5000

type Env = Record<string, string | undefined>
type FetchLike = typeof fetch

export type AgentModelPicker = {
  models: AgentModelOption[]
  /** True when the full catalog is merged in, so the form should render the searchable, provider-filterable picker. */
  searchable: boolean
  /** Short helper text under the picker, or null. */
  note: string | null
}

/** The catalog is only usable on the opencode harness. */
export function catalogHarnessEnabled(env: Env): boolean {
  return resolveAgentHarness(env.AGENT_HARNESS) === "opencode"
}

/** Keeps tool-use language models with a well-formed `provider/model` id, sorted by provider then name. */
export function filterGatewayCatalog(payload: unknown): AgentModelOption[] {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const out: AgentModelOption[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    const entry = raw as { id?: unknown; name?: unknown; type?: unknown; tags?: unknown; owned_by?: unknown } | null
    if (!entry || typeof entry.id !== "string" || entry.type !== "language") continue
    if (!Array.isArray(entry.tags) || !entry.tags.includes("tool-use")) continue
    const id = entry.id
    if (!MODEL_SHAPE.test(id) || !id.includes("/") || seen.has(id)) continue
    seen.add(id)
    const provider = typeof entry.owned_by === "string" && entry.owned_by.trim() ? entry.owned_by.trim() : id.split("/")[0]
    const label = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id
    out.push({ value: id, label, provider })
  }
  return out.sort((a, b) => (a.provider ?? "").localeCompare(b.provider ?? "") || a.label.localeCompare(b.label))
}

/** Fetches and filters the catalog. Null on any failure or an empty result. */
export async function fetchGatewayCatalog(fetchImpl: FetchLike = fetch): Promise<AgentModelOption[] | null> {
  try {
    const response = await fetchImpl(GATEWAY_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    } as RequestInit)
    if (!response.ok) return null
    const models = filterGatewayCatalog(await response.json())
    return models.length ? models : null
  } catch {
    return null
  }
}

/** The catalog for this deployment, or null when the harness cannot use it or the gateway could not be read. */
export async function loadAgentModelCatalog(env: Env = process.env, fetchImpl?: FetchLike): Promise<AgentModelOption[] | null> {
  if (!catalogHarnessEnabled(env)) return null
  return fetchGatewayCatalog(fetchImpl)
}

/** What the Model field offers: curated entries first, then the catalog (deduplicated), plus a note explaining any limit. */
export async function agentModelPicker(env: Env = process.env, fetchImpl?: FetchLike): Promise<AgentModelPicker> {
  const curated = allowedAgentModels(env)
  if (!catalogHarnessEnabled(env)) {
    return { models: curated, searchable: false, note: "Only Claude models can be used here: this deployment runs the Claude harness. The full AI Gateway catalog is available when the deployment uses the opencode harness." }
  }
  const catalog = await fetchGatewayCatalog(fetchImpl)
  if (!catalog) return { models: curated, searchable: false, note: "The AI Gateway model catalog is unavailable right now, so only the curated models are listed. Existing choices are kept." }
  const curatedValues = new Set(curated.map((option) => option.value))
  return { models: [...curated, ...catalog.filter((option) => !curatedValues.has(option.value))], searchable: true, note: null }
}

/**
 * Server-action write path: the curated rules of parseAgentModel, plus any catalog id when the catalog is available and
 * the harness can serve it. The catalog is only fetched for a shaped value that the curated list does not already accept.
 */
export async function parseAgentModelWithCatalog(value: unknown, env: Env = process.env, fetchImpl?: FetchLike): Promise<string | null> {
  try {
    return parseAgentModel(value, env)
  } catch (curatedError) {
    if (typeof value !== "string") throw curatedError
    const trimmed = value.trim()
    if (!MODEL_SHAPE.test(trimmed) || !catalogHarnessEnabled(env)) throw curatedError
    const catalog = await loadAgentModelCatalog(env, fetchImpl)
    if (catalog?.some((option) => option.value === trimmed)) return trimmed
    throw curatedError
  }
}
