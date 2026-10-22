/**
 * Which model answers a chat turn, and which models the chat may offer.
 *
 * Precedence: an explicit per-turn pick > the running agent's own model > the deployment default. The pick comes from the
 * browser, so it is never trusted: it must be a member of the allowed set (lib/agent-models.ts) that the active harness can
 * actually serve (agentModelForHarness), and the deployment's provider must accept Anthropic-API model names.
 *
 * Bedrock: its model ids are inference-profile ids (`global.anthropic.claude-sonnet-5-5`), not Anthropic-API names, and the
 * allowed set holds only the latter. Offering them would send a name Bedrock cannot serve, so on Bedrock the chat offers no
 * model choice at all and a request that names one is refused (a named agent's own model is likewise ignored there, as
 * buildAgentEnv already does). The opencode harness has no provider switch, so it offers the gateway ids.
 */
import { allowedAgentModels, type AgentModelOption } from "@/lib/agent-models"
import { agentModelForHarness, opencodeModel, type AgentHarness } from "@/lib/agent-harness"
import { resolveModelId, resolveProviderName } from "@/lib/agent-model"

type Env = Record<string, string | undefined>

/** Whether this deployment can honour any model choice: not on the Claude harness over Bedrock (or an unusable provider). */
export function modelChoiceSupported(harness: AgentHarness, env: Env = process.env): boolean {
  return harness === "opencode" || resolveProviderName(env) === "anthropic"
}

/** The models the chat picker offers on this deployment (empty = no picker). */
export function selectableTurnModels(harness: AgentHarness, env: Env = process.env): AgentModelOption[] {
  if (!modelChoiceSupported(harness, env)) return []
  return allowedAgentModels(env).filter((option) => agentModelForHarness(option.value, harness) !== null)
}

/** What a turn runs on when neither the user nor the agent chooses: the deployment's own default. */
export function deploymentDefaultModel(harness: AgentHarness, env: Env = process.env): string {
  if (harness === "opencode") return opencodeModel(env.AGENT_OPENCODE_MODEL)
  return resolveModelId(resolveProviderName(env) ?? "anthropic", env)
}

/** The model a named agent really runs on here, or null when it falls back to the deployment default. */
export function agentOwnModel(agentModel: string | null | undefined, harness: AgentHarness, env: Env = process.env): string | null {
  return modelChoiceSupported(harness, env) ? agentModelForHarness(agentModel, harness) : null
}

export type RequestedModel = { ok: true; model: string | null } | { ok: false; message: string; code: "INVALID_MODEL" | "MODEL_CHOICE_UNAVAILABLE" }

/** Validates the `model` field of a turn request. Absent, null or blank = no explicit pick. */
export function parseRequestedTurnModel(value: unknown, harness: AgentHarness, env: Env = process.env): RequestedModel {
  if (value === undefined || value === null) return { ok: true, model: null }
  if (typeof value !== "string") return { ok: false, message: "model must be one of the available models.", code: "INVALID_MODEL" }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, model: null }
  if (!modelChoiceSupported(harness, env)) {
    return { ok: false, message: "Choosing a model is not available on this deployment's model provider.", code: "MODEL_CHOICE_UNAVAILABLE" }
  }
  if (!selectableTurnModels(harness, env).some((option) => option.value === trimmed)) {
    return { ok: false, message: `"${trimmed.slice(0, 60)}" is not an available model.`, code: "INVALID_MODEL" }
  }
  return { ok: true, model: trimmed }
}

/** The model the run will really use: explicit pick > the agent's own > the deployment default. */
export function effectiveTurnModel(input: { explicit: string | null; agentModel: string | null | undefined; harness: AgentHarness; env?: Env }): string {
  const env = input.env ?? process.env
  return input.explicit ?? agentOwnModel(input.agentModel, input.harness, env) ?? deploymentDefaultModel(input.harness, env)
}
