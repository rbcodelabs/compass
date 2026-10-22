"use client"

import { Bot } from "lucide-react"
import { ChoiceChip, type ChoiceOption } from "@/components/agent/composer/choice-chip"
import type { AgentChoices } from "@/components/agent/use-agent-choices"

/**
 * The agent options, in the order the old selector had them: Default (the resolved default agent), the built-in
 * Compass Agent on purpose ("builtin"), then every cloud agent the member can pick. The value is "" / "builtin" / an agent id.
 */
export function agentOptionsFor(choices: AgentChoices, defaultAgentName: string): ChoiceOption[] {
  return [
    { value: "", label: `Default (${defaultAgentName})` },
    { value: "builtin", label: "Compass Agent" },
    ...choices.agents.map((agent) => ({ value: agent.id, label: agent.name, shared: agent.shared })),
  ]
}

export function AgentChip(props: {
  choices: AgentChoices
  value: string
  defaultAgentName: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <ChoiceChip
      kind="Agent"
      icon={<Bot />}
      options={agentOptionsFor(props.choices, props.defaultAgentName)}
      value={props.value}
      onChange={props.onChange}
      disabled={props.disabled}
    />
  )
}
