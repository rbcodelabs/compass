"use client"

import Link from "next/link"
import { Link2 } from "lucide-react"
import { entityPath } from "@/lib/entity-links"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import type { ConversationObjectLink } from "@/lib/links/conversation-links"

const URL_TYPE = { OPPORTUNITY: "opportunity", SOLUTION: "solution", TASK: "task" } as const

/**
 * The chat's "Linked objects" card: the Opportunities, Solutions and Tasks this conversation created or touched, each with its title and a
 * link that opens it. Comes from the server (the conversation's entity links), so it survives a reload and reaches participants. Renders
 * nothing when there are none.
 */
export function LinkedObjectsCard({ items, orgSlug, workspaceSlug }: { items: ConversationObjectLink[]; orgSlug: string; workspaceSlug: string }) {
  const labels = useLabels()
  if (items.length === 0) return null
  const typeLabel = { OPPORTUNITY: labels.opportunity.singular, SOLUTION: labels.solution.singular, TASK: "Task" } as const
  return (
    <section aria-label="Linked objects" data-testid="linked-objects" className="rounded-lg border border-default bg-surface-inset p-2.5">
      <header className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
        <Link2 className="size-3.5" aria-hidden="true" />
        Linked objects
        <span className="ml-auto font-normal text-text-subtle tabular-nums">{items.length}</span>
      </header>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.linkId} data-testid="linked-object" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs">
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-text-subtle">{typeLabel[item.entityType]}</span>
            <Link href={entityPath({ orgSlug, workspaceSlug, type: URL_TYPE[item.entityType], id: item.entityId })} className="min-w-0 break-words text-text-primary hover:underline underline-offset-2">
              {item.title}
            </Link>
            <span className="shrink-0 text-text-subtle">{item.kind === "CREATED" ? "created" : "mentioned"}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
