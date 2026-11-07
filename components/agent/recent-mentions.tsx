"use client"

// "Recent" row above the composer: the Compass objects and links the assistant has mentioned in this thread, as pills.
// A shortcut, not context: clicking opens the thing; the + inserts its link into the message. Nothing here is sent on
// its own. Entity pills are AgentLink, the same pill the transcript renders (live title and status, hover card,
// open-in-place), so a record looks and behaves the same in both places.

import { useMemo, useSyncExternalStore } from "react"
import { Plus } from "lucide-react"

import { extractMentions, type Mention } from "@/lib/agent-mentions"
import { AgentLink } from "@/components/agent/entity-link-card"
import { PILL } from "@/components/patterns/entity-pill"
import { useWorkItemLinkScope } from "@/components/work-item-link-scope"
import { cn } from "@/lib/utils"

const subscribeNever = () => () => {}

type Props = {
  messages: ReadonlyArray<{ role: string; content: string }>
  /** Insert text into the composer (appends to any draft). */
  onInsert: (text: string) => void
  limit?: number
}

export function RecentMentions({ messages, onInsert, limit = 8 }: Props) {
  const origin = useSyncExternalStore(subscribeNever, () => window.location.origin, () => null)
  const scope = useWorkItemLinkScope()
  const mentions = useMemo(() => extractMentions(messages, origin, limit, scope), [messages, origin, limit, scope])
  if (mentions.length === 0) return null
  return (
    <div data-testid="agent-recent-mentions" className="mx-auto mb-2 flex w-full max-w-3xl min-w-0 items-center gap-2">
      <span className="shrink-0 text-[11px] text-text-subtle">Recent</span>
      <ul aria-label="Recently mentioned" className="m-0 flex min-w-0 list-none gap-1.5 overflow-x-auto p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {mentions.map((m) => (
          <li key={m.key} className="shrink-0">
            <MentionPill mention={m} onInsert={onInsert} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function MentionPill({ mention, onInsert }: { mention: Mention; onInsert: (t: string) => void }) {
  const label = mention.kind === "external" ? mention.host : mention.link.id
  return (
    <span className="group/pill inline-flex items-center gap-0.5">
      {mention.kind === "entity" ? (
        // The pill resolves its own title; the label only shows if the record cannot be read, when it is a plain link.
        <AgentLink href={mention.href}>{label}</AgentLink>
      ) : (
        <a href={mention.href} target="_blank" rel="noopener noreferrer" title={mention.href} className={cn(PILL, "pl-2.5 underline-offset-2")}>
          <span className="min-w-0 truncate">{mention.host}</span>
        </a>
      )}
      <button
        type="button"
        aria-label={"Add " + label + " to message"}
        title="Add to message"
        onClick={() => onInsert(mention.href)}
        className="grid size-[18px] shrink-0 place-items-center rounded-full text-text-subtle opacity-0 outline-none hover:bg-surface-interactive hover:text-text-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/pill:opacity-100"
      >
        <Plus className="size-3" aria-hidden="true" />
      </button>
    </span>
  )
}
