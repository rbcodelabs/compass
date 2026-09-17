"use client"

// Runtime picker for the "Send to agent" affordance: Compass's own built-in
// cloud agent (today's only behavior) vs. a local Geode/Agent Threads runtime
// reached through the Geode Web Viewer bridge (`window.__geode.postEvent`).
//
// Not to be confused with components/tasks/task-assignee-picker.tsx, which
// assigns a Task to an `Agent` record (a data write, no dispatch) — this is a
// different flow entirely.
//
// Bridge detection is client-side and post-mount only: SSR has no `window`,
// so detecting during render would produce a client/server markup mismatch.
// Until the effect runs (and whenever the bridge is absent, i.e. every normal
// browser), this renders the exact same <Link> the two call sites rendered
// before this component existed — same href, same className, same children —
// so existing tests and behavior are unaffected outside Geode.
import * as React from "react"
import Link from "next/link"
import { ChevronDownIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { AgentHandoffEntityType, GeodeAgentHandoffPayload } from "@/lib/agent-context"

declare global {
  interface Window {
    __geode?: {
      postEvent?: (event: string, payload: unknown) => void
    }
  }
}

function hasGeodeBridge(): boolean {
  return typeof window !== "undefined" && typeof window.__geode?.postEvent === "function"
}

type HandoffContextResponse = {
  entityType: string
  entityId: string
  orgSlug: string
  workspaceSlug: string
  label: string
  summary: string
  suggestedInstruction: string
  promptBlock: string
  sourceUrl: string
}

type Props = {
  orgSlug: string
  workspaceSlug: string
  entityType: AgentHandoffEntityType
  entityId: string
  /** Exact className the call site used on its old <Link>. */
  className?: string
  /** Exact children the call site used inside its old <Link>. */
  children: React.ReactNode
}

export function SendToAgentPicker({ orgSlug, workspaceSlug, entityType, entityId, className, children }: Props) {
  // Starts false so the very first client render (hydration) matches the
  // server render exactly; flips to true post-mount if the bridge is present.
  const [bridgePresent, setBridgePresent] = React.useState(false)

  React.useEffect(() => {
    setBridgePresent(hasGeodeBridge())
  }, [])

  const builtInHref = `/${orgSlug}/${workspaceSlug}/agent?entityType=${entityType}&entityId=${entityId}`

  if (!bridgePresent) {
    return (
      <Link href={builtInHref} className={className}>
        {children}
      </Link>
    )
  }

  async function handleSendToGeode() {
    let data: HandoffContextResponse
    try {
      const params = new URLSearchParams({ orgSlug, workspaceSlug, entityType, entityId })
      const response = await fetch(`/api/agent/handoff-context?${params.toString()}`)
      if (!response.ok) {
        console.warn(`[send-to-agent-picker] handoff-context request failed with status ${response.status}`)
        return
      }
      data = await response.json()
    } catch (error) {
      // Degraded hand-off context is not surfaced to the user — same
      // no-toast convention as lib/agent-context.ts's own resolver.
      console.warn("[send-to-agent-picker] handoff-context request failed", error)
      return
    }

    if (typeof window.__geode?.postEvent !== "function") {
      console.warn("[send-to-agent-picker] Geode bridge disappeared before hand-off could be posted")
      return
    }

    const payload: GeodeAgentHandoffPayload = {
      entityType: data.entityType as AgentHandoffEntityType,
      entityId: data.entityId,
      orgSlug: data.orgSlug,
      workspaceSlug: data.workspaceSlug,
      label: data.label,
      summary: data.summary,
      suggestedInstruction: data.suggestedInstruction,
      promptBlock: data.promptBlock,
      // sourceUrl is workspace-relative (matches AgentHandoffContext); Geode
      // is a separate app on its own origin and can't resolve a relative
      // path against itself, so it's made absolute and renamed here.
      url: new URL(data.sourceUrl, window.location.origin).toString(),
    }
    window.__geode.postEvent("agent.handoff", payload)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={className}>
        {children}
        <ChevronDownIcon className="size-3" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem className="p-0">
          <Link href={builtInHref} className="flex w-full items-center gap-1.5 px-1.5 py-1">
            Built-in cloud agent
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleSendToGeode}>Geode</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
