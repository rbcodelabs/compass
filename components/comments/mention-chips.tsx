import type { ReactNode } from "react"
import { bodySegments, parseMentionHref } from "@/lib/comment-mentions"
import type { MentionOption, MentionOptions } from "@/components/docs/mention-editor"
import { cn } from "@/lib/utils"

const kindKey = (kind: string, id: string) => kind + ":" + id

export function chipClass(kind: "user" | "agent", outside?: boolean) {
  return cn("mention-chip", kind === "agent" && "mention-chip-agent", outside && "mention-chip-outside")
}

/** Live option lookup so a rename never leaves a stale label in a stored mention. */
export function mentionLookup(options: MentionOptions): Map<string, MentionOption> {
  const live = new Map<string, MentionOption>()
  for (const option of [...options.people, ...options.agents, ...options.outside]) live.set(kindKey(option.kind, option.id), option)
  return live
}

/** A comment body with each mention token drawn as a chip (plain text elsewhere). Used where the body is not markdown. */
export function MentionChips({ body, options }: { body: string; options: MentionOptions }) {
  const live = mentionLookup(options)
  return (
    <>
      {bodySegments(body).map((segment, index) => {
        if (segment.type === "text") return <span key={index}>{segment.text}</span>
        const { kind, id, label } = segment.mention
        const option = live.get(kindKey(kind, id))
        return (
          <span key={index} data-testid="comment-mention" data-mention-id={id} className={chipClass(kind, option?.outsideWorkspace)}>
            @{option?.name ?? label}
          </span>
        )
      })}
    </>
  )
}

/**
 * Link renderer for MarkdownContent: a `mention:` href (from mentionsAsMarkdownLinks) becomes a chip, anything else
 * a normal link. Module-level so MarkdownContent keeps a stable component identity.
 */
export function MentionAwareLink({ href, children }: { href?: string; children?: ReactNode }) {
  const mention = parseMentionHref(href)
  if (mention) {
    return <span data-testid="comment-mention" data-mention-id={mention.id} className={chipClass(mention.kind, mention.outside)}>{children}</span>
  }
  if (!href) return <span>{children}</span>
  const external = /^(?:https?:)?\/\//i.test(href)
  return <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>
}
