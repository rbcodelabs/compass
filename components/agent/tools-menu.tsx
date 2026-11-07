"use client"

import { Check, Minus, Wrench } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { ConnectorChoice } from "@/components/agent/use-agent-choices"

/**
 * Whether the turn will carry the user connected accounts. Mirrors app/api/agent/turn/route.ts: the built-in Compass
 * agent does, and so does a personal agent the user runs (it acts as its owner); a shared agent never does.
 * The agentSelection argument is "" (follow the default), "builtin", or an agent id, as the Agent selector holds it.
 * An agent missing from the list fails closed.
 */
export function connectorsEnabledFor(agentSelection: string, defaultAgentId: string | null, agents: Array<{ id: string; shared: boolean }> = []): boolean {
  if (agentSelection === "builtin") return true
  const agentId = agentSelection || defaultAgentId
  if (!agentId) return true
  const agent = agents.find((candidate) => candidate.id === agentId)
  return !!agent && !agent.shared
}

/** Read-only view of what a session can use: the Compass tools plus the user's connected accounts, and why any are off. */
export function ToolsMenu({ connectors, enabled, loaded }: { connectors: ConnectorChoice[]; enabled: boolean; loaded: boolean }) {
  if (!loaded) return null
  const active = enabled ? connectors.length : 0
  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2 text-xs text-foreground hover:bg-muted"
        aria-label="Tools available in this session"
      >
        <Wrench className="size-3" aria-hidden="true" />
        Tools{connectors.length > 0 ? ` · ${active}` : ""}
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 rounded-lg bg-popover p-3 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10">
        <ul className="flex flex-col gap-2">
          <li className="flex items-center gap-2">
            <Check className="size-3 text-status-success" aria-hidden="true" />
            <span>Compass (workspace tools)</span>
          </li>
          {connectors.map((connector) => (
            <li key={connector.slug} className="flex items-center gap-2" data-testid={`tools-menu-${connector.slug}`}>
              {enabled ? <Check className="size-3 text-status-success" aria-hidden="true" /> : <Minus className="size-3 text-muted-foreground" aria-hidden="true" />}
              <span className={enabled ? undefined : "text-muted-foreground"}>
                {connector.name}
                {connector.access ? ` · ${connector.access}` : ""}
              </span>
              <span className="ml-auto text-muted-foreground">{enabled ? "On" : "Off"}</span>
            </li>
          ))}
        </ul>
        {connectors.length === 0 && <p className="mt-2 text-muted-foreground">No connected accounts. Connect one in Settings → Agents.</p>}
        {connectors.length > 0 && !enabled && (
          <p className="mt-2 text-muted-foreground">A shared agent doesn’t use your connected accounts. Switch the Agent to Compass Agent or one of your personal agents to use them.</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
