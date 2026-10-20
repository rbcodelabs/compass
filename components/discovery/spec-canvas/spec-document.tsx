"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import Link from "next/link"
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, SquareArrowOutUpRightIcon } from "lucide-react"
import { EmptyState, EntityCard, StatusBadge } from "@/components/patterns"
import { ArtifactPreview } from "@/components/docs/artifact-preview"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SpecRail } from "./spec-rail"
import { AddItem, EnumPicker, InlineMarkdown, InlineText } from "./inline-fields"
import { useSpecEditor, type SaveState } from "./use-spec-editor"
import {
  ASSUMPTION_STATUS_OPTIONS, EXPERIMENT_STATUS_OPTIONS, OPPORTUNITY_STATUS_OPTIONS, RISK_LEVEL_OPTIONS, SOLUTION_STATUS_OPTIONS, groupByParent,
} from "@/lib/spec-canvas/options"
import { buildTraceabilityRail, humanizeEnum, SPEC_SECTION_IDS, type SpecCanvas, type SpecSectionKey } from "@/lib/spec-canvas/shape"
import type { SpecContext } from "@/lib/spec-canvas/mutations"
import type { ResolvedLabels } from "@/lib/thinking-model/labels"

type Props = { spec: SpecCanvas; labels: ResolvedLabels; backHref: string; context: SpecContext; readOnly: boolean }

const idLabel = (displayId: string | null) => (displayId ? <span className="font-mono">{displayId}</span> : undefined)

function OpenLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} aria-label={`Open ${label}`} className="rounded p-1 text-text-subtle hover:bg-surface-inset hover:text-text-primary focus-visible:outline-2 focus-visible:outline-ring">
      <SquareArrowOutUpRightIcon className="size-3.5" aria-hidden />
    </Link>
  )
}

function Section({ sectionKey, title, hint, collapsed, onToggle, children }: {
  sectionKey: SpecSectionKey; title: string; hint?: string; collapsed: boolean; onToggle: () => void; children: ReactNode
}) {
  const id = SPEC_SECTION_IDS[sectionKey]
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-24 space-y-4">
      <div>
        <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight text-text-primary">
          <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="-ml-6 flex items-center gap-1 rounded text-left focus-visible:outline-2 focus-visible:outline-ring">
            {collapsed ? <ChevronRightIcon className="size-5 text-text-subtle" aria-hidden /> : <ChevronDownIcon className="size-5 text-text-subtle" aria-hidden />}
            {title}
          </button>
        </h2>
        {hint && !collapsed && <p className="mt-1 text-sm text-text-subtle">{hint}</p>}
      </div>
      {!collapsed && children}
    </section>
  )
}

function SaveIndicator({ save }: { save: SaveState }) {
  const text = save.error ? save.error : save.pending > 0 ? "Saving…" : save.savedAt ? "Saved" : ""
  return (
    <span role="status" aria-live="polite" data-testid="spec-save-state" className={save.error ? "text-xs text-status-danger" : "text-xs text-text-subtle"}>
      {text}
    </span>
  )
}

/**
 * The Product Spec Canvas: one long document, outcome -> prototype. Prose, status
 * and risk edit in place and autosave; solutions, assumptions and experiments can
 * be added under their parent. It is still a lens over existing records: every
 * change goes through the existing mutation paths (lib/spec-canvas/mutations.ts).
 */
export function SpecDocument({ spec: initial, labels, backHref, context, readOnly }: Props) {
  const ctx = useMemo(() => context, [context])
  const { spec, save, saveField, addSolution, addAssumption, addExperiment } = useSpecEditor(initial, ctx)
  const rail = useMemo(() => buildTraceabilityRail(spec, labels), [spec, labels])
  const { opportunity } = spec
  const [collapsed, setCollapsed] = useState<ReadonlySet<SpecSectionKey>>(new Set())
  const [openAdd, setOpenAdd] = useState<string | null>(null)
  const toggle = (key: SpecSectionKey) => setCollapsed((current) => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const reveal = (key: SpecSectionKey, addKey: string) => {
    setCollapsed((current) => { const next = new Set(current); next.delete(key); return next })
    setOpenAdd(addKey)
    document.getElementById(SPEC_SECTION_IDS[key])?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const [menuOpen, setMenuOpen] = useState(false)
  // "/" opens the insert menu from anywhere in the document flow that is not a text field.
  useEffect(() => {
    if (readOnly) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest("input, textarea, select, [contenteditable='true'], [role='menu']"))) return
      event.preventDefault()
      setMenuOpen(true)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [readOnly])

  const lastSolution = spec.solutions[spec.solutions.length - 1]
  const lastAssumption = spec.assumptions[spec.assumptions.length - 1]
  const none = (what: string) => <EmptyState compact title={`No ${what} yet`} description={readOnly ? "This part of the chain is still open." : "Add the first one below."} />
  const isCollapsed = (key: SpecSectionKey) => collapsed.has(key)
  const solutionRef = (id: string) => ({ id, title: spec.solutions.find((s) => s.id === id)?.title ?? "" })
  const assumptionRef = (id: string) => ({ id, title: spec.assumptions.find((a) => a.id === id)?.title ?? "" })
  const assumptionGroups = groupByParent(spec.solutions, spec.assumptions, (a) => a.solutionId)
  const experimentGroups = groupByParent(spec.assumptions, spec.experiments, (e) => e.assumptionId)

  return (
    <div data-slot="spec-canvas" className="@container min-h-full min-w-0">
      <header className="sticky top-0 z-20 border-b border-border-default bg-surface-app/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6 md:px-8">
          <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            <Link href={backHref} className="flex w-fit shrink-0 items-center gap-1 text-text-secondary hover:text-text-primary">
              <ChevronLeftIcon className="size-4" aria-hidden /> {labels.opportunity.singular}
            </Link>
            <span aria-hidden className="text-text-disabled">/</span>
            <span aria-current="page" className="min-w-0 truncate font-medium text-text-primary">Spec: {opportunity.title}</span>
          </nav>
          <SaveIndicator save={save} />
          {!readOnly && (
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger aria-label="Insert" className="flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-sm text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-ring">
                <PlusIcon className="size-4" aria-hidden /> Insert <kbd className="ml-1 rounded bg-surface-inset px-1 text-xs text-text-subtle">/</kbd>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => reveal("solutions", "solution")}>{labels.solution.singular}</DropdownMenuItem>
                <DropdownMenuItem disabled={!lastSolution} onClick={() => lastSolution && reveal("assumptions", `assumption:${lastSolution.id}`)}>Assumption{lastSolution ? ` under ${lastSolution.title}` : ""}</DropdownMenuItem>
                <DropdownMenuItem disabled={!lastAssumption} onClick={() => lastAssumption && reveal("experiments", `experiment:${lastAssumption.id}`)}>Experiment{lastAssumption ? ` for ${lastAssumption.title}` : ""}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-8 sm:px-6 md:px-8 @[880px]:grid-cols-[190px_minmax(0,1fr)] @[880px]:gap-12">
        <SpecRail items={rail} ariaLabel="Spec traceability" />

        <main className="flex min-w-0 max-w-4xl flex-col gap-12 pl-6">
          <div>
            <div className="mb-1 text-xs font-medium text-text-subtle">Product spec{opportunity.displayId && <> · <span className="font-mono">{opportunity.displayId}</span></>}</div>
            <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
              <InlineText value={opportunity.title} label={`${labels.opportunity.lower} title`} readOnly={readOnly} onSave={(next) => saveField("opportunity", opportunity.id, "title", next)} />
            </h1>
          </div>

          <Section sectionKey="outcome" title={`${labels.objective.plural} & ${labels.keyResult.plural}`} hint="What this work is meant to move." collapsed={isCollapsed("outcome")} onToggle={() => toggle("outcome")}>
            {spec.objectives.length === 0 ? none(labels.objective.lowerPlural) : spec.objectives.map((objective) => (
              <EntityCard
                key={objective.id}
                eyebrow={<>{labels.objective.singular}{objective.displayId && <> · {idLabel(objective.displayId)}</>}</>}
                title={objective.title}
                description={objective.description}
                status={<StatusBadge status={objective.status === "OFF_TRACK" ? "danger" : objective.status === "AT_RISK" ? "warning" : objective.status === "COMPLETE" ? "success" : "info"}>{humanizeEnum(objective.status)}</StatusBadge>}
                actions={<OpenLink href={objective.href} label={objective.title} />}
              >
                {objective.keyResults.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {objective.keyResults.map((kr) => (
                      <li key={kr.id} className="rounded-lg border border-border-default bg-surface-panel p-3">
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

          <Section sectionKey="opportunity" title={labels.opportunity.singular} collapsed={isCollapsed("opportunity")} onToggle={() => toggle("opportunity")}>
            <div className="flex flex-wrap items-center gap-3">
              <EnumPicker label={`${labels.opportunity.singular} status`} value={opportunity.status} tone={opportunity.statusTone} options={OPPORTUNITY_STATUS_OPTIONS} readOnly={readOnly} onPick={(next) => saveField("opportunity", opportunity.id, "status", next)} />
              {opportunity.customerSegment && <span className="text-sm text-text-subtle">{opportunity.customerSegment}</span>}
              <OpenLink href={opportunity.href} label={opportunity.title} />
            </div>
            <InlineMarkdown label={`${labels.opportunity.lower} description`} placeholder={`Describe the ${labels.opportunity.lower}…`} value={opportunity.description} readOnly={readOnly} onSave={(next) => saveField("opportunity", opportunity.id, "description", next)} />
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

          <Section sectionKey="solutions" title={labels.solution.plural} hint={`How we might address this ${labels.opportunity.lower}.`} collapsed={isCollapsed("solutions")} onToggle={() => toggle("solutions")}>
            {spec.solutions.length === 0 && none(labels.solution.lowerPlural)}
            {spec.solutions.map((solution) => (
              <EntityCard
                key={solution.id}
                eyebrow={idLabel(solution.displayId)}
                title={<InlineText value={solution.title} label={`${labels.solution.lower} title`} readOnly={readOnly} onSave={(next) => saveField("solution", solution.id, "title", next)} />}
                status={<EnumPicker label={`${labels.solution.singular} status`} value={solution.status} tone={solution.statusTone} options={SOLUTION_STATUS_OPTIONS} readOnly={readOnly} onPick={(next) => saveField("solution", solution.id, "status", next)} />}
                actions={<OpenLink href={solution.href} label={solution.title} />}
                metadata={`${solution.assumptionCount} assumptions · ${solution.artifactCount} prototypes`}
              >
                <InlineMarkdown label={`${labels.solution.lower} description`} placeholder="Describe the approach…" value={solution.description} readOnly={readOnly} onSave={(next) => saveField("solution", solution.id, "description", next)} />
              </EntityCard>
            ))}
            {!readOnly && <AddItem label={`Add ${labels.solution.lower}`} placeholder={`${labels.solution.singular} title`} open={openAdd === "solution"} onOpenChange={(open) => setOpenAdd(open ? "solution" : null)} onCreate={addSolution} />}
          </Section>

          <Section sectionKey="assumptions" title="Assumptions" hint="What must be true, riskiest first." collapsed={isCollapsed("assumptions")} onToggle={() => toggle("assumptions")}>
            {spec.solutions.length === 0 && none("assumptions")}
            {assumptionGroups.map(({ parent: solution, items }) => (
              <div key={solution.id} className="space-y-3">
                <h3 className="text-sm font-semibold text-text-secondary">{solution.title}</h3>
                {items.map((assumption) => (
                  <EntityCard
                    key={assumption.id}
                    eyebrow={idLabel(assumption.displayId)}
                    title={<InlineText value={assumption.title} label="assumption title" readOnly={readOnly} onSave={(next) => saveField("assumption", assumption.id, "title", next)} />}
                    status={<span className="flex gap-1.5">
                      <EnumPicker label="Risk level" suffix="risk" value={assumption.riskLevel} tone={assumption.riskTone} options={RISK_LEVEL_OPTIONS} readOnly={readOnly} onPick={(next) => saveField("assumption", assumption.id, "riskLevel", next)} />
                      <EnumPicker label="Assumption status" value={assumption.status} tone={assumption.statusTone} options={ASSUMPTION_STATUS_OPTIONS} readOnly={readOnly} onPick={(next) => saveField("assumption", assumption.id, "status", next)} />
                    </span>}
                    actions={<OpenLink href={assumption.href} label={assumption.title} />}
                    metadata={`${assumption.experimentCount} experiments`}
                  >
                    <InlineMarkdown label="assumption description" placeholder="Add detail…" value={assumption.description} readOnly={readOnly} onSave={(next) => saveField("assumption", assumption.id, "description", next)} />
                  </EntityCard>
                ))}
                {!readOnly && <AddItem label="Add assumption" placeholder="What must be true?" open={openAdd === `assumption:${solution.id}`} onOpenChange={(open) => setOpenAdd(open ? `assumption:${solution.id}` : null)} onCreate={(title) => addAssumption(solutionRef(solution.id), title)} />}
              </div>
            ))}
          </Section>

          <Section sectionKey="experiments" title="Experiments" hint="How we are testing the assumptions." collapsed={isCollapsed("experiments")} onToggle={() => toggle("experiments")}>
            {spec.assumptions.length === 0 && none("experiments")}
            {experimentGroups.map(({ parent: assumption, items }) => (
              <div key={assumption.id} className="space-y-3">
                <h3 className="text-sm font-semibold text-text-secondary">{assumption.title}</h3>
                {items.map((experiment) => (
                  <EntityCard
                    key={experiment.id}
                    eyebrow={idLabel(experiment.displayId)}
                    title={<InlineText value={experiment.title} label="experiment title" readOnly={readOnly} onSave={(next) => saveField("experiment", experiment.id, "title", next)} />}
                    status={<span className="flex gap-1.5">
                      <EnumPicker label="Experiment status" value={experiment.status} tone={experiment.statusTone} options={EXPERIMENT_STATUS_OPTIONS} readOnly={readOnly} onPick={(next) => saveField("experiment", experiment.id, "status", next)} />
                      {experiment.conclusion && experiment.conclusionTone && <StatusBadge status={experiment.conclusionTone}>{humanizeEnum(experiment.conclusion)}</StatusBadge>}
                    </span>}
                    actions={<OpenLink href={experiment.href} label={experiment.title} />}
                  >
                    <div className="space-y-2 text-sm">
                      <p className="text-xs font-medium text-text-subtle">Hypothesis</p>
                      <InlineText value={experiment.hypothesis} label="experiment hypothesis" readOnly={readOnly} className="text-sm text-text-secondary" onSave={(next) => saveField("experiment", experiment.id, "hypothesis", next)} />
                      {experiment.conclusionReason && <p className="text-text-secondary">{experiment.conclusionReason}</p>}
                    </div>
                  </EntityCard>
                ))}
                {!readOnly && <AddItem label="Add experiment" placeholder="What will we try?" open={openAdd === `experiment:${assumption.id}`} onOpenChange={(open) => setOpenAdd(open ? `experiment:${assumption.id}` : null)} onCreate={(title) => addExperiment(assumptionRef(assumption.id), title)} />}
              </div>
            ))}
          </Section>

          <Section sectionKey="prototypes" title="Prototypes" hint={`Visual artifacts attached to the ${labels.solution.lowerPlural}.`} collapsed={isCollapsed("prototypes")} onToggle={() => toggle("prototypes")}>
            {spec.artifacts.length === 0 ? none("prototypes") : spec.artifacts.map((artifact) => (
              <EntityCard
                key={artifact.id}
                eyebrow={<>{artifact.solutionTitles.join(", ")}{artifact.displayId && <> · {idLabel(artifact.displayId)}</>}</>}
                title={artifact.title}
                description={artifact.description}
                status={artifact.kind === "SLIDE_DECK" ? <StatusBadge>Slide deck</StatusBadge> : undefined}
                actions={<OpenLink href={artifact.href} label={artifact.title} />}
              >
                {artifact.previewHtml || artifact.externalUrl ? (
                  <div className="h-96 overflow-auto rounded-lg border border-border-default bg-surface-base">
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
