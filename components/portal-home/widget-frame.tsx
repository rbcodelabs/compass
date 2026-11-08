import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { cn } from "@/lib/utils"

/** Shared presentational pieces for widget renderers. No hooks: safe on the server. */

/**
 * Card styles per template, driven by `data-tpl` / `data-hero` on the surrounding TemplateScope (a `group/home`
 * ancestor). Outside a scope (team home) none of these match and the card keeps its base look.
 * Written out in full (not generated) so Tailwind's scanner sees every class.
 */
const FRAME_BY_TEMPLATE =
  "group-data-[tpl=editorial]/home:rounded-lg group-data-[tpl=editorial]/home:p-6 group-data-[tpl=editorial]/home:shadow-none group-data-[tpl=bento]/home:rounded-2xl group-data-[tpl=bento]/home:p-6 group-data-[tpl=bento]/home:shadow-lg group-data-[tpl=shell]/home:rounded-lg group-data-[tpl=shell]/home:p-4 group-data-[tpl=shell]/home:shadow-sm group-data-[tpl=hub]/home:rounded-xl group-data-[tpl=hub]/home:p-6 group-data-[tpl=hub]/home:shadow-none"

const TITLE_BY_TEMPLATE =
  "group-data-[tpl=editorial]/home:text-xl group-data-[tpl=editorial]/home:font-medium group-data-[tpl=editorial]/home:tracking-tight group-data-[tpl=editorial]/home:[font-family:Iowan_Old_Style,Palatino_Linotype,Palatino,Georgia,serif] group-data-[tpl=bento]/home:text-lg group-data-[tpl=bento]/home:font-extrabold group-data-[tpl=bento]/home:tracking-tight group-data-[tpl=shell]/home:text-sm group-data-[tpl=shell]/home:font-semibold group-data-[tpl=hub]/home:text-lg group-data-[tpl=hub]/home:font-bold group-data-[tpl=hub]/home:tracking-tight"

/** Announcement ("hero" tone): a brand gradient in bento, a light brand wash everywhere else (hub adds an accent rule). */
const HERO_BY_TEMPLATE = [
  "group-data-[tpl=editorial]/home:border-border-default group-data-[tpl=editorial]/home:bg-primary/10 group-data-[tpl=editorial]/home:text-text-primary",
  "group-data-[tpl=shell]/home:border-border-default group-data-[tpl=shell]/home:bg-primary/10 group-data-[tpl=shell]/home:text-text-primary",
  "group-data-[tpl=bento]/home:bg-[linear-gradient(135deg,color-mix(in_srgb,var(--primary)_68%,black),var(--primary))] dark:group-data-[tpl=bento]/home:bg-[linear-gradient(135deg,color-mix(in_srgb,var(--primary)_70%,white),var(--primary))]",
  "group-data-[tpl=hub]/home:border-border-default group-data-[tpl=hub]/home:border-l-4 group-data-[tpl=hub]/home:border-l-primary! group-data-[tpl=hub]/home:bg-surface-panel group-data-[tpl=hub]/home:text-text-primary",
].join(" ")

export function WidgetCard({ title, children, className, tone = "panel" }: { title?: string; children: ReactNode; className?: string; tone?: "panel" | "hero" }) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-3 rounded-xl border p-5 shadow-[var(--shadow-card)]",
        tone === "hero" ? "border-transparent bg-primary text-primary-foreground" : "border-border-default bg-surface-panel text-text-primary",
        FRAME_BY_TEMPLATE,
        tone === "hero" && HERO_BY_TEMPLATE,
        className,
      )}
    >
      {title ? <h2 className={cn("text-base font-semibold", TITLE_BY_TEMPLATE)}>{title}</h2> : null}
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
