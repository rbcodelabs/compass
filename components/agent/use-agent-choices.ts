"use client"

import { useEffect, useState } from "react"

export type AgentChoice = { id: string; name: string; shared: boolean }
export type AgentChoices = { agents: AgentChoice[]; defaultAgentId: string | null }

const NONE: AgentChoices = { agents: [], defaultAgentId: null }

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
        if (!cancelled && Array.isArray(body.agents)) setChoices({ agents: body.agents, defaultAgentId: body.defaultAgentId ?? null })
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
