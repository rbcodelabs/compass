"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import type { RailItem } from "@/lib/spec-canvas/shape"

/**
 * Sticky traceability rail: the outcome -> prototype chain as anchor links, with
 * the section currently in view highlighted. Plain `#anchor` links keep it
 * usable without scripting; the observer only adds the highlight.
 */
export function SpecRail({ items, ariaLabel }: { items: RailItem[]; ariaLabel: string }) {
  const [activeId, setActiveId] = useState(items[0]?.anchorId ?? "")

  useEffect(() => {
    const visible = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id)
          else visible.delete(entry.target.id)
        }
        // The topmost visible section wins, in document (chain) order.
        const first = items.find((item) => visible.has(item.anchorId))
        if (first) setActiveId(first.anchorId)
      },
      // A band just under the sticky header: a section is "in view" once its top crosses it.
      { rootMargin: "-80px 0px -60% 0px" },
    )
    for (const item of items) {
      const element = document.getElementById(item.anchorId)
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [items])

  return (
    <nav aria-label={ariaLabel} data-slot="spec-rail" className="sticky top-20 hidden self-start @[880px]:block">
      <ol className="relative flex flex-col gap-1 border-l border-border-default">
        {items.map((item) => {
          const active = item.anchorId === activeId
          return (
            <li key={item.key}>
              <a
                href={`#${item.anchorId}`}
                aria-current={active ? "location" : undefined}
                className={cn(
                  "-ml-px flex items-center justify-between gap-3 border-l-2 py-1.5 pr-2 pl-3 text-sm transition-colors",
                  active ? "border-border-interactive font-medium text-text-primary" : "border-transparent text-text-secondary hover:text-text-primary",
                  item.count === 0 && "text-text-subtle",
                )}
              >
                <span className="truncate">{item.label}</span>
                <span className="text-xs tabular-nums text-text-subtle">{item.count}</span>
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
