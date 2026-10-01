import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { cn } from "@/lib/utils"

/** Shared presentational pieces for widget renderers. No hooks: safe on the server. */

export function WidgetCard({ title, children, className, tone = "panel" }: { title?: string; children: ReactNode; className?: string; tone?: "panel" | "hero" }) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-3 rounded-xl border p-5 shadow-[var(--shadow-card)]",
        tone === "hero" ? "border-transparent bg-primary text-primary-foreground" : "border-border-default bg-surface-panel text-text-primary",
        className,
      )}
    >
      {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
      {children}
    </div>
  )
}

export function PortalLink({ href, external, children, className }: { href: string; external?: boolean; children: ReactNode; className?: string }) {
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    )
  }
  return <Link href={href} className={className}>{children}</Link>
}

export function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
      {children}
      <ArrowUpRight className="size-3.5" aria-hidden />
    </Link>
  )
}

/** Paragraphs from blank-line separated plain text. Never HTML. */
export function PlainParagraphs({ text, className }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  return (
    <div className={cn("flex flex-col gap-2 text-sm leading-6", className)}>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="whitespace-pre-line">{paragraph}</p>
      ))}
    </div>
  )
}

export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}
