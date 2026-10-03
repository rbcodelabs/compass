"use client";

/**
 * The shared roadmap item detail body, mounted in two places (the same
 * "one component, two mount points" shape as TaskDetail and OpportunityDetail):
 *   1. Inside PanelShell, as the "roadmapItem" panel type.
 *   2. Inside /roadmap/[itemId]/page.tsx, full width.
 *
 * It is also the only place a roadmap item is edited — it replaced the card's
 * separate Edit dialog. Container width, not the mount point, decides the
 * layout, and the body is keyed by identity so drafts and in-flight loads never
 * leak between items.
 */
import { useEffect, useId, useRef, useState } from "react";
import { MessageSquare, CalendarDays, Lock, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Combobox, ComboboxContent, ComboboxTrigger, ComboboxValue } from "@/components/ui/combobox";
import {
  useEntityDetail,
  patchEntityField,
  PanelSkeleton,
  PanelError,
  EditableText,
  Section,
  Field,
  RelationList,
  StatusSelect,
  type EditContext,
  type RelationItem,
} from "@/components/panels/panel-parts";
import { usePanelContext } from "@/components/panels/panel-context";
import { LaunchTierPicker } from "@/components/panels/launch-tier-picker";
import { LaunchChecklist, type LaunchChecklistItemData } from "@/components/panels/launch-checklist";
import { PositioningBriefRow } from "@/components/panels/positioning-brief-row";
import { LinkedTasksSection, type LinkedTaskData } from "@/components/tasks/linked-tasks-section";
import { Discussion } from "@/components/comments/discussion";
import { FollowButton } from "@/components/following/follow-button";
import { RequestDecisionLink } from "@/components/decisions/request-decision-link";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import { MeasurementsPanel } from "@/components/analytics/measurements-panel";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { MarkdownContent } from "@/components/markdown-content";
import { archiveItem } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { HORIZON_META, SETTABLE_HORIZONS } from "@/lib/roadmap";
import { linkToPlaceholder } from "@/lib/thinking-model/copy";
import { peekPanelSeed, clearPanelSeed } from "@/lib/panel-seed";
import type { CustomFieldWithValue } from "@/lib/custom-field-definitions";
import type { Horizon, MemberData, SquadData } from "@/lib/types";
import type { RoadmapCardData } from "./roadmap-card";

type RoadmapItemData = {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  horizon: string;
  status: string;
  isPrivate: boolean;
  startDate: string | null;
  endDate: string | null;
  updatedAt: string;
  squadId: string | null;
  opportunityId: string | null;
  squad: { id: string; name: string; color: string } | null;
  solution: { id: string; title: string } | null;
  keyResult: { id: string; title: string } | null;
  opportunity: { id: string; title: string } | null;
  experiment: { id: string; title: string } | null;
  feedback: { id: string; title: string } | null;
  launchChecklist: { id: string; tier: string; items: LaunchChecklistItemData[] } | null;
  positioningBrief: { id: string; title: string } | null;
  launchWorkflowEnabled: boolean;
  deliveryTasks: LinkedTaskData[];
  linkableTasks: Array<{ id: string; title: string }>;
  members: MemberData[];
  customFields: CustomFieldWithValue[];
  squads: SquadData[];
  availableOpportunities: Array<{ id: string; title: string }>;
  _count: { votes: number };
};

// Display map for the horizon badge — every horizon, including the launch
// ones (an item can currently be in LAUNCHING/LAUNCHED and must render).
const HORIZON: Record<string, { label: string; className: string }> = Object.fromEntries(
  Object.entries(HORIZON_META).map(([h, m]) => [h, { label: m.label, className: m.badgeClass }])
);

// The dropdown only offers horizons the generic single-field edit will accept
// — LAUNCHING is excluded (only setLaunchTier may enter it). Display of a
// current LAUNCHING value still works via the map above.
const HORIZON_ORDER = SETTABLE_HORIZONS;

const NONE = "__none__";
const CHIP = "inline-flex h-6 items-center gap-1 rounded-full bg-status-neutral-surface px-2 text-xs font-medium text-status-neutral";

// Start/end dates are plain dates stored as UTC midnight, so format in UTC —
// local formatting would show the previous day for any negative UTC offset.
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const formatRange = (start: string, end: string) => `${DATE_FORMAT.format(new Date(start))} – ${DATE_FORMAT.format(new Date(end))}`;
const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** The card-shaped fields the board needs to stay in step with an edit. */
export function toCardPatch(d: RoadmapItemData): Partial<RoadmapCardData> {
  return {
    title: d.title,
    description: d.description,
    horizon: d.horizon as Horizon,
    isPrivate: d.isPrivate,
    startDate: d.startDate,
    endDate: d.endDate,
    updatedAt: d.updatedAt,
    opportunityId: d.opportunityId,
    opportunity: d.opportunity,
    squad: d.squad,
  };
}

/** Both dates or neither: a roadmap range is inclusive, so a lone date is never valid. */
function ScheduleField({ data, edit }: { data: RoadmapItemData; edit: EditContext }) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(toDateInput(data.startDate));
  const [end, setEnd] = useState(toDateInput(data.endDate));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(next: { startDate: string | null; endDate: string | null }) {
    setSaving(true);
    setError(null);
    try {
      const res = await patchEntityField(edit.type, edit.id, edit.orgSlug, edit.workspaceSlug, "schedule", next);
      edit.onSaved(res.data);
      setEditing(false);
    } catch {
      setError("Could not save dates. Use a start on or before the end.");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => { setStart(toDateInput(data.startDate)); setEnd(toDateInput(data.endDate)); setError(null); setEditing(true); }}
        aria-label={data.startDate && data.endDate ? `Dates: ${formatRange(data.startDate, data.endDate)}` : "Dates: not set"}
        title="Click to edit dates"
        className="inline-flex min-h-7 items-center gap-1 rounded-md px-1 text-xs hover:bg-muted/60"
      >
        <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {data.startDate && data.endDate ? <span>{formatRange(data.startDate, data.endDate)}</span> : <span className="italic text-muted-foreground">Set dates</span>}
      </button>
    );
  }

  const complete = start !== "" && end !== "";
  const valid = (start === "" && end === "") || (complete && start <= end);
  return (
    <form
      className="flex w-full min-w-0 flex-wrap items-end gap-2 rounded-md border border-border-default p-2"
      onSubmit={(e) => { e.preventDefault(); if (valid) void save({ startDate: start || null, endDate: end || null }); }}
    >
      <label className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">Start date<Input type="date" value={start} onChange={(e) => setStart(e.target.value)} disabled={saving} className="h-8 w-36" /></label>
      <label className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">End date<Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} disabled={saving} className="h-8 w-36" /></label>
      <Button type="submit" size="sm" disabled={saving || !valid || (start === "" && end === "" && !data.startDate)}>Save dates</Button>
      <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setEditing(false)}>Cancel</Button>
      {(data.startDate || data.endDate) && <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void save({ startDate: null, endDate: null })}>Clear dates</Button>}
      {!valid && <p role="alert" className="w-full text-xs text-destructive">Set both dates, with the start on or before the end.</p>}
      {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
    </form>
  );
}

function SquadField({ data, edit }: { data: RoadmapItemData; edit: EditContext }) {
  const [error, setError] = useState<string | null>(null);
  if (!data.squads?.length) return null;

  async function handleChange(value: string | null) {
    const next = !value || value === NONE ? null : value;
    if (next === data.squadId) return;
    setError(null);
    try {
      const res = await patchEntityField(edit.type, edit.id, edit.orgSlug, edit.workspaceSlug, "squadId", next);
      edit.onSaved(res.data);
    } catch {
      setError("Could not assign squad.");
    }
  }

  const active = data.squads.find((s) => s.id === data.squadId);
  return (
    <div className="min-w-0 max-w-44">
      <Combobox
        items={[
          { value: NONE, label: "No squad" },
          ...data.squads.map((squad) => ({
            value: squad.id,
            label: squad.name,
            render: (
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: squad.color }} />
                {squad.name}
              </span>
            ),
          })),
        ]}
        value={data.squadId ?? NONE}
        onValueChange={handleChange}
      >
        <ComboboxTrigger aria-label="Squad" className="h-7 w-full min-w-0 justify-between text-xs">
          {active ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: active.color }} />
              <ComboboxValue className="truncate" />
            </span>
          ) : (
            <ComboboxValue placeholder="No squad" />
          )}
        </ComboboxTrigger>
        <ComboboxContent />
      </Combobox>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

type Props = {
  itemId: string;
  orgSlug: string;
  workspaceSlug: string;
  variant: "panel" | "page";
};

export function RoadmapItemDetail(props: Props) {
  const [attempt, setAttempt] = useState(0);
  return <RoadmapItemDetailBody key={`${props.orgSlug}/${props.workspaceSlug}/${props.itemId}/${attempt}`} {...props} onRetry={() => setAttempt((value) => value + 1)} />;
}

function RoadmapItemDetailBody({ itemId, orgSlug, workspaceSlug, variant, onRetry }: Props & { onRetry: () => void }) {
  const { notifyEntityMutated } = usePanelContext();
  const labels = useLabels();
  const { data, error, mutate, refresh } = useEntityDetail<RoadmapItemData>("roadmapItem", itemId, orgSlug, workspaceSlug);
  const discussionRef = useRef<HTMLElement>(null);
  const discussionId = useId();
  const [actionError, setActionError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  // The seed has done its job once the fetch settles. Cleared in an effect,
  // not during render, so Strict Mode / concurrent renders can't lose it early.
  const settled = !!data || !!error;
  useEffect(() => {
    if (settled) clearPanelSeed("roadmapItem", itemId);
  }, [settled, itemId]);

  const titleClass = variant === "page" ? "w-full text-2xl font-bold tracking-tight leading-tight" : "w-full text-base font-semibold leading-snug";
  // Relation rows extend 8px past their column for the hover surface. The panel's
  // px-5 absorbs that; on the page the same 8px is claimed back with -mx-2/px-2 so
  // rows never overflow the page container (layouts scroll, never clip).
  const wrapper = `@container min-w-0 break-words pb-8 ${variant === "panel" ? "px-5" : "-mx-2 px-2"}`;

  if (error && !data) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3">
        <PanelError label="roadmap item" />
        <Button variant="outline" onClick={onRetry}>Retry loading roadmap item</Button>
      </div>
    );
  }
  if (!data) {
    // Paint what the board card already knew, read-only, while the full
    // payload loads. Sections that need the fetch stay a skeleton.
    const seed = peekPanelSeed<RoadmapCardData>("roadmapItem", itemId);
    if (!seed) return <PanelSkeleton />;
    return (
      <div data-slot="roadmap-item-detail" data-variant={variant} className={wrapper}>
        <div className="flex min-w-0 flex-col gap-3">
          <h1 className={titleClass}>{seed.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={HORIZON[seed.horizon]?.className ?? "bg-surface-inset text-text-secondary"}>{HORIZON[seed.horizon]?.label ?? seed.horizon}</Badge>
            {seed.squad && <span className={CHIP}>{seed.squad.name}</span>}
          </div>
          {seed.description && <MarkdownContent className="text-sm text-foreground/80">{seed.description}</MarkdownContent>}
          <PanelSkeleton />
        </div>
      </div>
    );
  }

  const roadmapPath = `/${orgSlug}/${workspaceSlug}/roadmap`;
  const archived = data.status === "ARCHIVED";

  const edit: EditContext = {
    type: "roadmapItem",
    id: itemId,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => {
      const saved = d as RoadmapItemData;
      mutate(saved);
      notifyEntityMutated("roadmapItem", saved.id, { horizon: saved.horizon as Horizon, updatedAt: saved.updatedAt, roadmapItem: toCardPatch(saved) });
    },
  };

  async function saveField(field: string, value: unknown) {
    setActionError(null);
    try {
      const res = await patchEntityField(edit.type, edit.id, orgSlug, workspaceSlug, field, value);
      edit.onSaved(res.data);
    } catch {
      setActionError("Could not save that change. Try again.");
    }
  }

  async function handleArchive() {
    setArchiving(true);
    setActionError(null);
    try {
      await archiveItem(itemId, data!.workspaceId);
      mutate((prev) => (prev ? { ...prev, status: "ARCHIVED" } : prev));
      notifyEntityMutated("roadmapItem", itemId, { archived: true });
    } catch {
      setActionError("Could not archive this item. Try again.");
    } finally {
      setArchiving(false);
    }
  }

  // The five possible origins collapse into one "linked" list.
  const linked: RelationItem[] = [];
  if (data.opportunity) linked.push({ type: "opportunity", id: data.opportunity.id, title: data.opportunity.title, badge: { label: labels.opportunity.singular } });
  if (data.solution) linked.push({ type: "solution", id: data.solution.id, title: data.solution.title, badge: { label: labels.solution.singular } });
  if (data.experiment) linked.push({ type: "experiment", id: data.experiment.id, title: data.experiment.title, badge: { label: "Experiment" } });
  if (data.keyResult) linked.push({ type: "keyResult", id: data.keyResult.id, title: data.keyResult.title, badge: { label: labels.keyResult.singular } });
  if (data.feedback) linked.push({ type: "feedback", id: data.feedback.id, title: data.feedback.title, badge: { label: "Feedback" } });

  return (
    <div data-slot="roadmap-item-detail" data-variant={variant} className={wrapper}>
      <div className="flex min-w-0 flex-col gap-4">
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            Could not refresh this roadmap item. Showing the last loaded details.
            <Button variant="outline" size="sm" onClick={refresh}>Retry refresh</Button>
          </div>
        )}

        <div className="flex min-w-0 flex-col gap-3">
          <h1 className="min-w-0"><EditableText value={data.title} field="title" edit={edit} className={titleClass} /></h1>
          <div aria-label="Roadmap item summary" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <StatusSelect value={data.horizon} field="horizon" options={HORIZON_ORDER} map={HORIZON} edit={edit} label="Horizon" />
            {archived && <Badge className="bg-status-neutral-surface text-status-neutral">Archived</Badge>}
            <SquadField data={data} edit={edit} />
            <ScheduleField key={`${data.startDate}/${data.endDate}`} data={data} edit={edit} />
            <span className={CHIP} title="Votes from the public roadmap"><ThumbsUp className="size-3" aria-hidden />{data._count.votes} {data._count.votes === 1 ? "vote" : "votes"}</span>
            {data.isPrivate && <span className={CHIP} title="Hidden from the public portal roadmap"><Lock className="size-3" aria-hidden />Private</span>}
            <Button
              variant="ghost"
              size="sm"
              aria-controls={discussionId}
              onClick={() => { discussionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); discussionRef.current?.focus({ preventScroll: true }); }}
            >
              <MessageSquare className="size-4" /> Discussion
            </Button>
            <FollowButton orgSlug={orgSlug} workspaceSlug={workspaceSlug} subjectType="ROADMAP_ITEM" subjectId={itemId} />
            <RequestDecisionLink
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              subjectType="ROADMAP_ITEM"
              subjectId={data.id}
              subjectTitle={data.title}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium hover:bg-muted"
            />
          </div>
          {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
          <EditableText
            value={data.description}
            field="description"
            edit={edit}
            multiline
            placeholder="Add a description…"
            className="text-sm text-foreground/80 leading-relaxed"
          />
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-7 @[801px]:grid-cols-[minmax(0,1fr)_310px] @[801px]:gap-8">
          <div data-slot="roadmap-item-detail-main" className="flex min-w-0 flex-col gap-4">
            {data.launchWorkflowEnabled && (
              <Section label="Launch">
                <div className="flex flex-col gap-4">
                  {data.launchChecklist ? (
                    <LaunchChecklist
                      horizon={data.horizon}
                      tier={data.launchChecklist.tier}
                      items={data.launchChecklist.items}
                      workspaceId={data.workspaceId}
                      revalidatePathStr={roadmapPath}
                    />
                  ) : (
                    <LaunchTierPicker itemId={itemId} workspaceId={data.workspaceId} revalidatePathStr={roadmapPath} onDone={refresh} />
                  )}
                  <PositioningBriefRow itemId={itemId} workspaceId={data.workspaceId} orgSlug={orgSlug} workspaceSlug={workspaceSlug} brief={data.positioningBrief} />
                </div>
              </Section>
            )}

            <Section label="Delivery tasks" count={data.deliveryTasks.length}>
              <LinkedTasksSection
                linkedType="ROADMAP_ITEM"
                linkedId={itemId}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                revalidatePathStr={roadmapPath}
                tasks={data.deliveryTasks}
                linkableTasks={data.linkableTasks}
                members={data.members}
                onChanged={refresh}
              />
            </Section>

            <Section label="Linked to" count={linked.length}>
              <RelationList items={linked} empty="Not linked to any discovery item." />
            </Section>

            {data.customFields.length > 0 && (
              <Section label="Details">
                <CustomFieldsPanel fields={data.customFields} objectId={itemId} revalidatePathStr={roadmapPath} onSaved={refresh} compact />
              </Section>
            )}

            <MeasurementsPanel orgSlug={orgSlug} workspaceSlug={workspaceSlug} target={{ targetType: "ROADMAP_ITEM", targetId: data.id }} compact />

            <Section label="More properties" collapsible panelType="roadmapItem">
              <Field label={labels.opportunity.singular} layout="row">
                <Combobox
                  items={[
                    { value: NONE, label: "— None —" },
                    ...(data.availableOpportunities ?? []).map((opportunity) => ({ value: opportunity.id, label: opportunity.title })),
                  ]}
                  value={data.opportunityId ?? NONE}
                  onValueChange={(value) => { const next = !value || value === NONE ? null : value; if (next !== data.opportunityId) void saveField("opportunityId", next); }}
                >
                  <ComboboxTrigger aria-label={labels.opportunity.singular} className="h-8 w-full min-w-0 justify-between text-sm">
                    <ComboboxValue placeholder={linkToPlaceholder(labels.opportunity)} />
                  </ComboboxTrigger>
                  <ComboboxContent />
                </Combobox>
              </Field>
              <Field label="Visibility" layout="row">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={data.isPrivate} onCheckedChange={(checked) => void saveField("isPrivate", checked === true)} />
                  Private (hidden from public roadmap)
                </label>
              </Field>
              {!archived && (
                <Field label="Archive" layout="row">
                  <Button variant="outline" size="sm" disabled={archiving} onClick={() => void handleArchive()}>
                    {archiving ? "Archiving…" : "Archive item"}
                  </Button>
                </Field>
              )}
            </Section>
          </div>

          <aside
            ref={discussionRef}
            id={discussionId}
            tabIndex={-1}
            aria-label="Roadmap item discussion"
            data-slot="roadmap-item-detail-discussion"
            className="min-w-0 scroll-mt-5 border-t border-border-default pt-6 focus-visible:outline-2 focus-visible:outline-ring @[801px]:border-t-0 @[801px]:border-l @[801px]:pt-0 @[801px]:pl-6"
          >
            <Discussion targetType="ROADMAP_ITEM" targetId={itemId} />
          </aside>
        </div>
      </div>
    </div>
  );
}
