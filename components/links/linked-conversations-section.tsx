"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { MessageSquareIcon, XIcon } from "lucide-react"
import { readObjectConversations, removeObjectConversationLink } from "@/app/[orgSlug]/[workspaceSlug]/links/conversation-actions"
import { Section } from "@/components/panels/panel-parts"
import type { ObjectConversationLink } from "@/lib/links/conversation-links"

type Props = { orgSlug: string; workspaceSlug: string; entityType: "OPPORTUNITY" | "SOLUTION" | "TASK"; entityId: string }

const KIND_LABEL = { CREATED: "Created here", MENTIONS: "Mentioned" } as const

/**
 * The "Conversations" section on an Opportunity, Solution or Task: the agent conversations that created or touched it, limited by the
 * server to the ones this viewer may open. Renders nothing while loading, on failure and when there are none, so an object with no agent
 * history shows no empty shell. A workspace member can remove a link; the agent re-adds it only if it touches the object again.
 */
export function LinkedConversationsSection({ orgSlug, workspaceSlug, entityType, entityId }: Props) {
  // Tagged with the object it was loaded for, so switching objects never shows the previous object's conversations.
  const objectKey = `${entityType}:${entityId}`
  const [loaded, setLoaded] = useState<{ key: string; items: ObjectConversationLink[] }>({ key: "", items: [] })
  const items = loaded.key === objectKey ? loaded.items : []
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const load = useCallback(async () => {
    try {
      const result = await readObjectConversations(orgSlug, workspaceSlug, { entityType, entityId })
      setLoaded({ key: objectKey, items: result.ok ? result.items : [] })
    } catch {
      setLoaded({ key: objectKey, items: [] })
    }
  }, [orgSlug, workspaceSlug, entityType, entityId, objectKey])

  useEffect(() => {
    void load()
  }, [load])

  function remove(item: ObjectConversationLink) {
    setError(null)
    startTransition(async () => {
      try {
        const result = await removeObjectConversationLink(orgSlug, workspaceSlug, item.linkId)
        if (!result.ok) setError(result.error)
        else await load()
      } catch {
        setError("Could not remove the link. Please try again.")
      }
    })
  }

  if (items.length === 0) return null
  return (
    <Section label="Conversations" count={items.length}>
      <div data-testid="linked-conversations" className="flex min-w-0 flex-col gap-2">
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.linkId} data-testid="linked-conversation" className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <Link href={`/${orgSlug}/${workspaceSlug}/agent?c=${item.conversationId}`} className="min-w-0 break-words text-sm hover:underline underline-offset-2">
                  {item.title}
                </Link>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{KIND_LABEL[item.kind]}</span>
                {item.archived && <span className="shrink-0 text-xs text-muted-foreground">Archived</span>}
              </div>
              <button
                type="button"
                onClick={() => remove(item)}
                disabled={pending}
                aria-label={`Remove link to conversation ${item.title}`}
                className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
              >
                <XIcon className="size-4" />
              </button>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </Section>
  )
}
