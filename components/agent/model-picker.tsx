"use client"

import { useCallback, useEffect, useState } from "react"
import type { AgentChoices } from "@/components/agent/use-agent-choices"

/** Remembered per user per workspace, in this browser only: a preference, not data. */
export function modelPickStorageKey(userId: string, workspaceId: string): string {
  return `compass:agent-model:${userId}:${workspaceId}`
}

function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ""
  } catch {
    return ""
  }
}

function writeStored(key: string, value: string) {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    // Private mode or a full quota: the pick still holds for this page view.
  }
}

/** The label for a model id: an option's own label, else the label the server sent for it, else the bare id. */
export function modelLabelFor(choices: Pick<AgentChoices, "models" | "modelLabels">, modelId: string): string {
  return choices.models.find((model) => model.value === modelId)?.label ?? choices.modelLabels[modelId] ?? modelId
}

/**
 * The model the chat would use if the user picked nothing: the selected agent's model, else the deployment default.
 * `agentSelection` is "" (follow the server's default agent), "builtin", or an agent id, exactly as the Agent selector holds it.
 */
export function defaultModelFor(choices: AgentChoices, agentSelection: string): string | null {
  if (agentSelection === "builtin") return choices.deploymentModel
  const agentId = agentSelection || choices.defaultAgentId
  const agent = agentId ? choices.agents.find((candidate) => candidate.id === agentId) : undefined
  return agent?.model ?? choices.deploymentModel
}

/**
 * State for the model picker. `model` is what to send (empty = no explicit pick, so the server applies the agent's own model,
 * else the deployment default); a remembered pick that is no longer offered (removed from COMPASS_CLOUD_AGENT_MODELS, or the
 * deployment moved to a provider that cannot honour a choice) is dropped and forgotten rather than sent.
 */
export function useModelPick(input: { userId: string; workspaceId: string; choices: AgentChoices; agentSelection: string }) {
  const { userId, workspaceId, choices, agentSelection } = input
  const key = modelPickStorageKey(userId, workspaceId)
  const [pick, setPick] = useState("")
  useEffect(() => setPick(readStored(key)), [key])

  const offered = choices.models.some((model) => model.value === pick)
  // Only judge a remembered pick once the choices have really loaded: before that, "nothing is offered" proves nothing.
  useEffect(() => {
    if (choices.loaded && pick && !offered) {
      setPick("")
      writeStored(key, "")
    }
  }, [choices.loaded, pick, offered, key])

  const defaultModel = defaultModelFor(choices, agentSelection)
  // Something to choose = at least one offered model other than what Default already gives.
  const visible = choices.models.some((model) => model.value !== defaultModel)
  const model = visible && offered ? pick : ""
  const select = useCallback(
    (next: string) => {
      setPick(next)
      writeStored(key, next)
    },
    [key],
  )
  return { visible, model, select, defaultModel, defaultLabel: defaultModel ? modelLabelFor(choices, defaultModel) : "deployment default" }
}

export function ModelPicker(props: {
  choices: AgentChoices
  value: string
  defaultLabel: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="flex min-w-[10rem] flex-1 items-center gap-2">
      <label htmlFor="model-selection" className="shrink-0">Model</label>
      <select
        id="model-selection"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        disabled={props.disabled}
        className="h-7 min-w-0 flex-1 truncate rounded-md border border-input bg-transparent px-2 text-xs text-foreground sm:max-w-xs"
      >
        <option value="">Default ({props.defaultLabel})</option>
        {props.choices.models.map((model) => (
          <option key={model.value} value={model.value}>{model.label}</option>
        ))}
      </select>
    </div>
  )
}
