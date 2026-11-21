"use client"

import { createContext, useContext, useEffect } from "react"
import Link from "next/link"
import { ExternalLink, MessageSquareCheck } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { FollowButton } from "@/components/following/follow-button"
import { requestDecisionHref } from "@/components/decisions/request-decision-link"
import type { TrackedSubjectType } from "@/lib/tracked-decisions"

/**
 * What a detail panel asks the panel shell to show in its header. Panels declare it; the shell renders it, in one fixed
 * order for every panel (Follow, Request decision, Open full page, then the shell's own View chain / Pin / Close), so a
 * panel never places these controls itself and they cannot drift between panels.
 */
export type PanelHeaderConfig = {
  /** The full-page route for this record. Task, Opportunity and Roadmap item default from the panel id. */
  fullPageHref?: string
  follow?: { subjectType: string; subjectId: string }
  decision?: { subjectType: TrackedSubjectType; subjectId: string; subjectTitle: string }
}

type Setter = (config: PanelHeaderConfig | null) => void

/** Provided by PanelShell around the panel body. `null` outside a shell (a full page renders the same component). */
export const PanelHeaderActionsContext = createContext<Setter | null>(null)

/**
 * Registers this panel's header actions with the shell while it is mounted, and returns whether a shell is present.
 * Call it before any early return (hooks), passing `{}` until the data has loaded. A component that also renders on a
 * full page (Opportunity, Roadmap item, Task) uses the return value to keep its inline controls when there is no shell.
 */
export function usePanelHeaderActions(config: PanelHeaderConfig): boolean {
  const set = useContext(PanelHeaderActionsContext)
  const key = JSON.stringify(config)
  useEffect(() => {
    if (!set) return
    set(JSON.parse(key) as PanelHeaderConfig)
    return () => set(null)
  }, [set, key])
  return set !== null
}

/** The shell's rendering of a panel's declared header actions. Renders nothing for an empty config. */
export function PanelHeaderIcons({
  config,
  orgSlug,
  workspaceSlug,
  fallbackFullPageHref,
}: {
  config: PanelHeaderConfig | null
  orgSlug: string
  workspaceSlug: string
  /** Used when the panel did not declare one (the three types whose route is known from the panel id). */
  fallbackFullPageHref: string | null
}) {
  const fullPageHref = config?.fullPageHref ?? fallbackFullPageHref
  return (
    <>
      {config?.follow && <FollowButton iconOnly orgSlug={orgSlug} workspaceSlug={workspaceSlug} {...config.follow} />}
      {config?.decision && (
        <Link
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          href={requestDecisionHref({ orgSlug, workspaceSlug, ...config.decision })}
          aria-label="Request decision"
          title="Request decision"
        >
          <MessageSquareCheck aria-hidden />
        </Link>
      )}
      {fullPageHref && (
        <Link
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          href={fullPageHref}
          aria-label="Open full page"
          title="Open full page"
        >
          <ExternalLink aria-hidden />
        </Link>
      )}
    </>
  )
}
