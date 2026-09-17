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
import { cn } from "@/lib/utils"
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

// Geode's bridge (`normalizeWebViewerEvent`) enforces this exact cap and
// silently drops anything over it — no error, just a dead button (Task
// cd908f23 comment from the receiver team, 2026-09-17). The API route
// already truncates `promptBlock` to a safe budget before it reaches us
// (see GEODE_HANDOFF_PROMPT_BLOCK_MAX_CHARS in lib/agent-context.ts), but
// label/summary/suggestedInstruction have no hard cap of their own and could
// in theory combine with an already-maxed promptBlock to still exceed this,
// so this is an independent second check on the fully-assembled payload
// right before it's posted.
const GEODE_MAX_PAYLOAD_JSON_LENGTH = 8192

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
      // The API route's sourceUrl is workspace-relative; sending it absolute
      // is strictly more correct (Compass already knows its own origin) even
      // though the receiver would also absolutize a relative one itself.
      // Key stays `sourceUrl` — the receiver's pinned contract (Task cd908f23
      // comment, 2026-09-17) uses that name, not `url`.
      sourceUrl: new URL(data.sourceUrl, window.location.origin).toString(),
    }

    const payloadSize = JSON.stringify(payload).length
    if (payloadSize > GEODE_MAX_PAYLOAD_JSON_LENGTH) {
      // Geode's bridge would silently drop this (see the constant's doc
      // comment) — indistinguishable from nothing happening at all. Warn
      // loudly here instead of firing an event we know will vanish.
      console.warn(
        `[send-to-agent-picker] hand-off payload JSON is ${payloadSize} chars, over Geode's ${GEODE_MAX_PAYLOAD_JSON_LENGTH}-char limit even after server-side truncation; not posting (entityType=${data.entityType}, entityId=${data.entityId})`
      )
      return
    }

    window.__geode.postEvent("agent.handoff", payload)
  }

  return (
    <DropdownMenu>
      {/* The trigger appends a chevron the call site's className knows nothing
          about, so it cannot rely on that className to lay it out: the reviews
          call site passes a plain `inline-block … underline` link style, which
          dropped the chevron onto its own line under the label. Append the
          flex layout *after* className so tailwind-merge resolves the display
          conflict in favour of inline-flex. `gap-1`/`items-center` match what
          buttonVariants({size:"xs"}) already applies, so the solution-panel
          call site — which passes exactly that — is visually unchanged. */}
      <DropdownMenuTrigger className={cn(className, "inline-flex items-center gap-1")}>
        {children}
        <ChevronDownIcon className="size-3" aria-hidden="true" />
      </DropdownMenuTrigger>
      {/* DropdownMenuContent defaults to w-(--anchor-width), i.e. exactly the
          trigger's width. These triggers are narrower than "Built-in cloud
          agent", which then wrapped to two lines. Size to content instead;
          the base min-w-32 still applies as a floor. */}
      <DropdownMenuContent className="w-auto">
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
