"use client"

import { AtSign, Bot, MessageSquareOff } from "lucide-react"
import { ChoiceChip, type ChoiceOption } from "@/components/agent/composer/choice-chip"
import type { AgentParticipationMode } from "@/lib/agent-participation-mode"

export const AGENT_MODE_OPTIONS: ChoiceOption[] = [
  { value: "AUTO", label: "Compass Agent (Auto)" },
  { value: "MENTION_ONLY", label: "On @mention" },
  { value: "NONE", label: "Off (Human-only)" },
]

export function AgentModeChip({
  value,
  disabled,
  onChange,
  onInsertMention,
}: {
  value: AgentParticipationMode
  disabled?: boolean
  onChange: (next: AgentParticipationMode) => void
  onInsertMention?: () => void
}) {
  const icon =
    value === "NONE" ? <MessageSquareOff /> : value === "MENTION_ONLY" ? <AtSign /> : <Bot />

  return (
    <div className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
      <ChoiceChip
        kind="Participation"
        icon={icon}
        options={AGENT_MODE_OPTIONS}
        value={value}
        onChange={(next) => {
          if (next === "AUTO" || next === "MENTION_ONLY" || next === "NONE") {
            onChange(next)
          }
        }}
        disabled={disabled}
      />
      {value === "MENTION_ONLY" && onInsertMention && (
        <button
          type="button"
          disabled={disabled}
          onClick={onInsertMention}
          data-testid="agent-quick-mention-pill"
          title="Insert @Compass Agent into your message so the agent replies to this turn"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <AtSign className="size-3 shrink-0" aria-hidden="true" />
          <span>Compass Agent</span>
        </button>
      )}
    </div>
  )
}
