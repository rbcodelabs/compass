"use client"

import { useEffect, useState } from "react"

/** `model` is the model the agent runs on here (null = the deployment default). */
export type AgentChoice = { id: string; name: string; shared: boolean; model?: string | null }
export type ModelChoice = { value: string; label: string }
export type AgentChoices = {
  agents: AgentChoice[]
  defaultAgentId: string | null
  /** The models a turn may be pinned to; empty = the deployment cannot honour a choice, so there is no model picker. */
  models: ModelChoice[]
  /** What a turn runs on when neither the user nor the agent picks a model. */
  deploymentModel: string | null
  /** A human label for every model id the client may display, besides the options themselves. */
  modelLabels: Record<string, string>
  /** False until the lookup has answered (it stays false if it fails). */
  loaded: boolean
}

const NONE: AgentChoices = { agents: [], defaultAgentId: null, models: [], deploymentModel: null, modelLabels: {}, loaded: false }

/**
 * The agents a member can pick in a workspace plus the resolved default (GET /api/agent/choices). Starts empty and stays
 * empty on any failure: the pickers then look and behave exactly as they did before cloud agents existed.
 */
export function useAgentChoices(target: { workspaceId: string } | { orgSlug: string; workspaceSlug: string }): AgentChoices {
  const [choices, setChoices] = useState<AgentChoices>(NONE)
  const query = "workspaceId" in target ? new URLSearchParams({ workspaceId: target.workspaceId }) : new URLSearchParams({ orgSlug: target.orgSlug, workspaceSlug: target.workspaceSlug })
  const key = query.toString()
  useEffect(() => {
    if (typeof fetch !== "function") return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`/api/agent/choices?${key}`)
        if (!response?.ok) return
        const body = (await response.json()) as Partial<AgentChoices>
        if (!cancelled && Array.isArray(body.agents)) {
          setChoices({
            agents: body.agents,
            defaultAgentId: body.defaultAgentId ?? null,
            models: Array.isArray(body.models) ? body.models : [],
            deploymentModel: body.deploymentModel ?? null,
            modelLabels: body.modelLabels && typeof body.modelLabels === "object" ? body.modelLabels : {},
            loaded: true,
          })
        }
      } catch {
        // Degraded to "no agents": the built-in agent still works.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [key])
  return choices
}
