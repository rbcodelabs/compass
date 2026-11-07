import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { HubSearch } from "./hub-search"

export interface HeroProps {
  name: string
  base: string
  roadmapPublic: boolean
  feedbackEnabled: boolean
  /** The home already has an announcement widget (it carries its own headline and buttons): no hero buttons. */
  hasAnnouncement: boolean
}

export function portalTagline(name: string): string {
  return `Follow what we are building and tell us what would make ${name} better for you.`
}

function HeroActions({ base, roadmapPublic, feedbackEnabled, hasAnnouncement, className, primaryClass, secondaryClass }: HeroProps & { className?: string; primaryClass: string; secondaryClass: string }) {
  if (hasAnnouncement || (!roadmapPublic && !feedbackEnabled)) return null
  return (
    <div className={cn("mt-8 flex flex-wrap gap-3", className)}>
      {roadmapPublic ? (
        <Link href={`${base}/roadmap`} className={primaryClass}>
          View the roadmap <ArrowRight className="size-4" aria-hidden />
        </Link>
      ) : null}
      {feedbackEnabled ? (
        <Link href={`${base}/feedback`} className={roadmapPublic ? secondaryClass : primaryClass}>
          Share feedback
        </Link>
      ) : null}
    </div>
  )
}

/** Editorial: a calm, centred hero. The serif display face is for this heading only. */
export function EditorialHero(props: HeroProps) {
  return (
    <section aria-label="Welcome" className="px-6 pb-4 pt-14 text-center sm:pt-20">
      <p className="inline-block rounded-full border border-border-default bg-surface-panel px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-text-subtle">Customer portal</p>
      <h1 className="mx-auto mb-5 mt-6 max-w-3xl text-balance text-5xl leading-[1.04] font-medium tracking-tight text-text-primary [font-family:Iowan_Old_Style,Palatino_Linotype,Palatino,Georgia,serif] sm:text-7xl">
        {props.name}
      </h1>
      <p className="mx-auto max-w-xl text-balance text-lg leading-relaxed text-text-secondary">{portalTagline(props.name)}</p>
      <HeroActions
        {...props}
        className="justify-center"
        primaryClass="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        secondaryClass="inline-flex h-10 items-center rounded-lg border border-border-strong bg-surface-panel px-5 text-sm font-medium text-text-primary hover:bg-surface-inset"
      />
    </section>
  )
}

/** Bento: the brand-colour gradient hero; the tiles overlap its bottom edge (see PortalMain). */
export function BentoHero(props: HeroProps) {
  return (
    <section aria-label="Welcome" className="relative z-0 mx-auto w-full max-w-5xl px-6 pb-36 pt-14 sm:pt-16">
      <p className="inline-flex items-center gap-2.5 rounded-full border border-primary-foreground/30 bg-primary-foreground/15 px-3.5 py-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-primary-foreground">
        <span className="size-2 rounded-full bg-primary-foreground shadow-[0_0_0_4px_rgba(255,255,255,0.25)]" aria-hidden />
        Customer portal
      </p>
      <h1 className="mt-5 max-w-3xl text-balance text-4xl leading-[1.02] font-extrabold tracking-[-0.04em] text-primary-foreground sm:text-6xl">{props.name}</h1>
      <p className="mt-5 max-w-xl text-lg leading-relaxed text-primary-foreground/90">{portalTagline(props.name)}</p>
      <HeroActions
        {...props}
        primaryClass="inline-flex h-11 items-center gap-2 rounded-full bg-primary-foreground px-5 text-sm font-bold text-primary hover:opacity-90"
        secondaryClass="inline-flex h-11 items-center rounded-full border border-primary-foreground/40 bg-primary-foreground/15 px-5 text-sm font-semibold text-primary-foreground hover:bg-primary-foreground/25"
      />
    </section>
  )
}

/** Docs hub: a search-first hero inside the dark header band. */
export function HubHero({ name }: HeroProps) {
  return (
    <section aria-label="Search the docs" className="mx-auto w-full max-w-3xl px-6 pb-14 pt-8 text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#A294FF]">Help and docs</p>
      <h1 className="mb-3 mt-3 text-balance text-4xl leading-[1.02] font-bold tracking-[-0.04em] text-[#FAF9F6] sm:text-6xl">How can we help?</h1>
      <p className="mx-auto mb-7 max-w-lg text-lg text-[#B9B3A9]">Guides and answers from the {name} team.</p>
      <HubSearch />
    </section>
  )
}
