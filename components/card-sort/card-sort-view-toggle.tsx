import Link from "next/link"
import type { ComponentType } from "react"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The view switcher, shared by the round board and the tally.
 *
 * ── Links, not buttons ─────────────────────────────────────────────────────
 *
 * The chosen view lives in the URL (`?view=`), so switching is navigation: it
 * survives a reload, it can be bookmarked or pasted to a colleague, and the
 * server renders only the view that was asked for instead of shipping both and
 * hiding one. A control that navigates should be an anchor.
 *
 * Styled with buttonVariants, never `<Button render={<Link/>}>`. Button is a Base
 * UI ButtonPrimitive: handing it an anchor throws unless you also pass
 * `nativeButton={false}`, and that emits `<a role="button" tabindex="0" href=…>`
 * — which compiles, renders, logs nothing, and announces the only navigating
 * control on the screen as a button. This is the repo idiom; see
 * components/settings/mcp-connectors-panel.tsx.
 *
 * `aria-current="page"` rather than a colour change alone, so which view is
 * active is conveyed to a screen reader and not only to the eye.
 */
export function CardSortViewToggle({
  label,
  options,
}: {
  /** Names the group, e.g. "Round view". Two toggles on one page need distinct names. */
  label: string
  options: readonly {
    href: string
    label: string
    icon: ComponentType<{ className?: string }>
    current: boolean
  }[]
}) {
  return (
    <nav aria-label={label} className="flex items-center gap-1">
      {options.map((option) => {
        const Icon = option.icon
        return (
          <Link
            key={option.href}
            href={option.href}
            aria-current={option.current ? "page" : undefined}
            className={cn(
              buttonVariants({ variant: option.current ? "secondary" : "ghost", size: "sm" })
            )}
          >
            <Icon className="size-4" />
            {option.label}
          </Link>
        )
      })}
    </nav>
  )
}
