import type { ReactNode } from "react"
import Link from "next/link"
import { ChevronLeftIcon } from "lucide-react"
import { EmptyState, EntityCard, StatusBadge } from "@/components/patterns"
import { MarkdownContent } from "@/components/markdown-content"
import { ArtifactPreview } from "@/components/docs/artifact-preview"
import { SpecRail } from "./spec-rail"
import { buildTraceabilityRail, humanizeEnum, SPEC_SECTION_IDS, type SpecCanvas, type SpecSectionKey } from "@/lib/spec-canvas/shape"
import type { ResolvedLabels } from "@/lib/thinking-model/labels"

type Props = { spec: SpecCanvas; labels: ResolvedLabels; backHref: string }

function CardLink({ href, children }: { href: string; children: ReactNode }) {
  // Stretched link: the whole card is the target while the title stays the accessible name.
  return <Link href={href} className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">{children}</Link>
}

function Section({ sectionKey, title, hint, children }: { sectionKey: SpecSectionKey; title: string; hint?: string; children: ReactNode }) {
  const id = SPEC_SECTION_IDS[sectionKey]
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-24 space-y-4">
      <div>
        <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight text-text-primary">{title}</h2>
        {hint && <p className="mt-1 text-sm text-text-subtle">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

const idLabel = (displayId: string | null) => (displayId ? <span className="font-mono">{displayId}</span> : undefined)

/**
 * The Product Spec Canvas: one long document, outcome -> prototype, where every
 * embedded record is a compact card that links to its live detail view. Pure
 * presentation of a `SpecCanvas`; it owns no data and offers no edits.
 */
export function SpecDocument({ spec, labels, backHref }: Props) {
  const rail = buildTraceabilityRail(spec, labels)
  const { opportunity } = spec
  const none = (what: string) => <EmptyState compact title={`No ${what} yet`} description="This part of the chain is still open." />

  return (
    <div data-slot="spec-canvas" className="min-h-full bg-surface-app">
      <header className="sticky top-0 z-20 border-b border-border-default bg-surface-app/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <Link href={backHref} className="flex w-fit shrink-0 items-center gap-1 text-sm text-text-secondary hover:text-text-primary">
            <ChevronLeftIcon className="size-4" aria-hidden /> {labels.opportunity.singular}
          </Link>
          <span aria-hidden className="text-text-disabled">/</span>
          <span className="truncate text-sm font-medium text-text-primary">Spec: {opportunity.title}</span>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-8 sm:px-6 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-12">
        <SpecRail items={rail} ariaLabel="Spec traceability" />

        <main className="flex min-w-0 max-w-3xl flex-col gap-12">
          <div>
            <div className="mb-1 text-xs font-medium text-text-subtle">Product spec{opportunity.displayId && <> · <span className="font-mono">{opportunity.displayId}</span></>}</div>
            <h1 className="text-3xl font-semibold tracking-tight text-text-primary">{opportunity.title}</h1>
          </div>

          <Section sectionKey="outcome" title={`${labels.objective.plural} & ${labels.keyResult.plural}`} hint="The outcome this work is meant to move.">
            {spec.objectives.length === 0 ? none(labels.objective.lowerPlural) : spec.objectives.map((objective) => (
              <EntityCard
                key={objective.id}
                interactive
                className="relative"
                eyebrow={<>{labels.objective.singular}{objective.displayId && <> · {idLabel(objective.displayId)}</>}</>}
                title={<CardLink href={objective.href}>{objective.title}</CardLink>}
                description={objective.description}
                status={<StatusBadge status={objective.status === "OFF_TRACK" ? "danger" : objective.status === "AT_RISK" ? "warning" : objective.status === "COMPLETE" ? "success" : "info"}>{humanizeEnum(objective.status)}</StatusBadge>}
              >
                {objective.keyResults.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {objective.keyResults.map((kr) => (
                      <li key={kr.id} className="relative z-10 rounded-lg border border-border-default bg-surface-panel p-3">
                        <div className="flex items-start justify-between gap-3">
                          <Link href={kr.href} className="text-sm font-medium text-text-primary hover:underline">{kr.title}</Link>
                          <span className="shrink-0 text-xs tabular-nums text-text-subtle">{kr.current} / {kr.target}{kr.unit ? ` ${kr.unit}` : ""}</span>
                        </div>
                        {kr.progress !== null && (
                          <div role="progressbar" aria-label={`${kr.title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(kr.progress * 100)} className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-inset">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(kr.progress * 100)}%` }} />
                          </div>
                        )}
                        <p className="mt-2 text-xs text-text-subtle">
                          {[kr.linkedVia.opportunity && `Linked to this ${labels.opportunity.lower}`, kr.linkedVia.solutionTitles.length > 0 && `Via ${kr.linkedVia.solutionTitles.join(", ")}`].filter(Boolean).join(" · ")}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </EntityCard>
            ))}
          </Section>

          <Section sectionKey="opportunity" title={labels.opportunity.singular}>
            <EntityCard
              interactive
              className="relative"
              eyebrow={opportunity.customerSegment ?? undefined}
              title={<CardLink href={opportunity.href}>{opportunity.title}</CardLink>}
              status={<StatusBadge status={opportunity.statusTone}>{humanizeEnum(opportunity.status)}</StatusBadge>}
            />
            {opportunity.description
              ? <MarkdownContent>{opportunity.description}</MarkdownContent>
              : <p className="text-sm text-text-subtle">No description yet.</p>}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-text-primary">Evidence ({spec.evidence.length})</h3>
              {spec.evidence.length === 0 ? <p className="text-sm text-text-subtle">No evidence attached yet.</p> : (
                <ul className="flex flex-col gap-2">
                  {spec.evidence.map((item) => (
                    <li key={item.id} className="rounded-lg border border-border-default bg-surface-card p-3 text-sm">
                      <p className="line-clamp-4 text-text-secondary">{item.excerpt}</p>
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-subtle">
                        <span>{humanizeEnum(item.sourceType)}</span>
                        <span aria-hidden>·</span>
                        <span>{humanizeEnum(item.confidence)} confidence</span>
                        {item.sourceUrl && /^https?:\/\//i.test(item.sourceUrl) && <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Source</a>}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Section>

          <Section sectionKey="solutions" title={labels.solution.plural} hint={`How we might address this ${labels.opportunity.lower}.`}>
            {spec.solutions.length === 0 ? none(labels.solution.lowerPlural) : spec.solutions.map((solution) => (
              <EntityCard
                key={solution.id}
                interactive
                className="relative"
                eyebrow={idLabel(solution.displayId)}
                title={<CardLink href={solution.href}>{solution.title}</CardLink>}
                description={solution.description}
                status={<StatusBadge status={solution.statusTone}>{humanizeEnum(solution.status)}</StatusBadge>}
                metadata={`${solution.assumptionCount} assumptions · ${solution.artifactCount} prototypes`}
              />
            ))}
          </Section>

          <Section sectionKey="assumptions" title="Assumptions" hint="What must be true, riskiest first.">
            {spec.assumptions.length === 0 ? none("assumptions") : spec.assumptions.map((assumption) => (
              <EntityCard
                key={assumption.id}
                interactive
                className="relative"
                eyebrow={<>{assumption.solutionTitle}{assumption.displayId && <> · {idLabel(assumption.displayId)}</>}</>}
                title={<CardLink href={assumption.href}>{assumption.title}</CardLink>}
                description={assumption.description}
                status={<span className="flex gap-1.5"><StatusBadge status={assumption.riskTone}>{humanizeEnum(assumption.riskLevel)} risk</StatusBadge><StatusBadge status={assumption.statusTone}>{humanizeEnum(assumption.status)}</StatusBadge></span>}
                metadata={`${assumption.experimentCount} experiments`}
              />
            ))}
          </Section>

          <Section sectionKey="experiments" title="Experiments" hint="How we are testing the assumptions.">
            {spec.experiments.length === 0 ? none("experiments") : spec.experiments.map((experiment) => (
              <EntityCard
                key={experiment.id}
                interactive
                className="relative"
                eyebrow={<>{experiment.assumptionTitle}{experiment.displayId && <> · {idLabel(experiment.displayId)}</>}</>}
                title={<CardLink href={experiment.href}>{experiment.title}</CardLink>}
                description={experiment.hypothesis}
                status={<span className="flex gap-1.5">
                  <StatusBadge status={experiment.statusTone}>{humanizeEnum(experiment.status)}</StatusBadge>
                  {experiment.conclusion && experiment.conclusionTone && <StatusBadge status={experiment.conclusionTone}>{humanizeEnum(experiment.conclusion)}</StatusBadge>}
                </span>}
              >
                {experiment.conclusionReason && <p className="text-sm text-text-secondary">{experiment.conclusionReason}</p>}
              </EntityCard>
            ))}
          </Section>

          <Section sectionKey="prototypes" title="Prototypes" hint={`Visual artifacts attached to the ${labels.solution.lowerPlural}.`}>
            {spec.artifacts.length === 0 ? none("prototypes") : spec.artifacts.map((artifact) => (
              <EntityCard
                key={artifact.id}
                interactive
                className="relative"
                eyebrow={<>{artifact.solutionTitles.join(", ")}{artifact.displayId && <> · {idLabel(artifact.displayId)}</>}</>}
                title={<CardLink href={artifact.href}>{artifact.title}</CardLink>}
                description={artifact.description}
                status={artifact.kind === "SLIDE_DECK" ? <StatusBadge>Slide deck</StatusBadge> : undefined}
              >
                {artifact.previewHtml || artifact.externalUrl ? (
                  // Above the stretched link so the frame stays interactive.
                  <div className="relative z-10 h-96 overflow-auto rounded-lg border border-border-default bg-surface-base">
                    <ArtifactPreview title={artifact.title} html={artifact.previewHtml ?? undefined} externalUrl={artifact.externalUrl} thumbnail={artifact.thumbnail} fill />
                  </div>
                ) : <p className="text-sm text-text-subtle">Open the artifact to view this prototype.</p>}
              </EntityCard>
            ))}
          </Section>
        </main>
      </div>
    </div>
  )
}
