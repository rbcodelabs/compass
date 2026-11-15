"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bot, CircleDashed, User } from "lucide-react";
import { StatusBadge } from "@/components/patterns/status-badge";
import { DecisionActions } from "@/components/decisions/decision-actions";
import { DecisionQuestionList } from "@/components/decisions/decision-answers";
import { DecisionLongForm } from "@/components/decisions/decision-long-form";
import { DecisionOutcomeBanner } from "@/components/decisions/decision-outcome-banner";
import { subjectPanelType } from "@/components/decisions/decision-sources";
import { DECISION_UPDATED_EVENT, decisionStatusBadgeProps } from "@/lib/decision-review-ui";
import type { TrackedDecisionAnswer, TrackedDecisionPacketQuestion } from "@/lib/tracked-decision-types";
import { useOptionalPanelContext, type EntityPanelType } from "./panel-context";
import { FullPageLink, PanelContainer, PanelError, PanelSkeleton } from "./panel-parts";

export type DecisionPanelData = {
  id: string;
  displayId?: string | null;
  workspaceId: string;
  state: string;
  isTracked: boolean;
  readOnlyLegacy: boolean;
  stale: boolean;
  title: string;
  summary: string | null;
  context: string | null;
  linkedTo: { type?: string; id?: string; title?: string } | null;
  sourcesCount?: number;
  requester?: { type: "USER" | "AGENT"; id: string; name: string } | null;
  revisionId: string;
  revisionNumber?: number;
  createdAt?: string | null;
  fingerprint: string;
  canDecide: boolean;
  options: Array<{ id: string; label: string; outcomeClass: string; actionKey?: string; description?: string | null }>;
  offeredChoices: Array<{ id: string; label: string; description: string | null }>;
  questions: TrackedDecisionPacketQuestion[];
  decision: {
    label: string;
    description: string | null;
    outcomeClass: string;
    actorRole: string;
    decidedByName?: string | null;
    decidedAt: string;
    rationale: string | null;
    answers: TrackedDecisionAnswer[];
  } | null;
};

/**
 * Slide-over view of a decision request: aligned with Inbox Triage (display ID, semantic status badge,
 * requester + subject pills, above-the-fold ballot / semantic outcome banner, and formatted context).
 * Follow-through tasks, supporting artifacts, and revision history live on the full page.
 */
export function DecisionPanel({ id, orgSlug, workspaceSlug }: { id: string; orgSlug: string; workspaceSlug: string }) {
  const [data, setData] = useState<DecisionPanelData | null>(null);
  const [error, setError] = useState(false);
  const panelCtx = useOptionalPanelContext();

  const load = useCallback(
    (signal?: AbortSignal) =>
      fetch("/api/panels/review/" + encodeURIComponent(id) + "?orgSlug=" + encodeURIComponent(orgSlug) + "&workspaceSlug=" + encodeURIComponent(workspaceSlug), { signal })
        .then((r) => {
          if (!r.ok) throw new Error("fetch failed");
          return r.json();
        })
        .then((res) => {
          setData(res.data as DecisionPanelData);
          setError(false);
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError") setError(true);
        }),
    [id, orgSlug, workspaceSlug],
  );

  useEffect(() => {
    setData(null);
    setError(false);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const onUpdated = () => {
      void load();
    };
    window.addEventListener(DECISION_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(DECISION_UPDATED_EVENT, onUpdated);
  }, [load]);

  if (error) return <PanelError label="decision" />;
  if (!data) return <PanelSkeleton />;

  const decision = data.decision;
  const badge = decisionStatusBadgeProps({
    state: data.state,
    outcomeClass: decision?.outcomeClass ?? null,
    outcomeLabel: decision?.label ?? null,
    stale: data.stale,
    readOnlyLegacy: data.readOnlyLegacy,
  });

  const linkedPanelType = subjectPanelType(data.linkedTo?.type);
  const linkedDocHref =
    data.linkedTo?.type === "DOC" && data.linkedTo.id
      ? `/${orgSlug}/${workspaceSlug}/docs/${data.linkedTo.id}`
      : null;

  return (
    <PanelContainer>
      <div className="flex flex-col items-start gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {data.displayId && (
            <span className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-xs text-text-secondary" data-testid="display-id">
              {data.displayId}
            </span>
          )}
          <StatusBadge
            status={badge.status}
            icon={!decision && !data.stale && !data.readOnlyLegacy && data.state === "PENDING" ? <CircleDashed /> : undefined}
          >
            {badge.label}
          </StatusBadge>
          {typeof data.revisionNumber === "number" && data.revisionNumber > 1 && (
            <span className="font-mono text-[11px] text-muted-foreground">Rev {data.revisionNumber}</span>
          )}
        </div>

        <h2 className="text-base font-semibold leading-snug break-words [overflow-wrap:anywhere] text-text-primary">
          {data.title}
        </h2>

        {(data.linkedTo?.title || data.requester) && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {data.linkedTo?.title && (
              linkedPanelType && data.linkedTo.id && panelCtx ? (
                <button
                  type="button"
                  onClick={() => panelCtx.openPanel(linkedPanelType as EntityPanelType, data.linkedTo!.id!)}
                  className="max-w-full truncate rounded-md border border-border-default bg-surface-inset px-2 py-0.5 font-medium text-text-primary transition-colors hover:bg-surface-hover"
                >
                  Linked to {data.linkedTo.title}
                </button>
              ) : linkedDocHref ? (
                <Link
                  href={linkedDocHref}
                  className="max-w-full truncate rounded-md border border-border-default bg-surface-inset px-2 py-0.5 font-medium text-text-primary transition-colors hover:bg-surface-hover"
                >
                  Linked to {data.linkedTo.title}
                </Link>
              ) : (
                <span className="max-w-full truncate">Linked to {data.linkedTo.title}</span>
              )
            )}
            {data.requester && (
              <span className="inline-flex min-w-0 items-center gap-1">
                {data.requester.type === "AGENT" ? (
                  <Bot className="size-3 shrink-0" aria-hidden="true" />
                ) : (
                  <User className="size-3 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">Requested by {data.requester.name}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Action-first Ballot / Recorded Outcome */}
      {data.readOnlyLegacy ? (
        <p className="rounded-lg border border-border-default bg-surface-inset p-3 text-sm text-muted-foreground">
          This legacy review is read-only.
        </p>
      ) : data.stale && !decision ? (
        <p className="rounded-lg border border-status-warning/30 bg-status-warning-surface p-3 text-sm text-status-warning">
          This request is stale and cannot be decided. A new revision is needed.
        </p>
      ) : decision ? (
        <DecisionOutcomeBanner
          compact
          label={decision.label}
          description={decision.description}
          outcomeClass={decision.outcomeClass}
          decidedBy={decision.decidedByName || decision.actorRole}
          formattedTimestamp={new Date(decision.decidedAt).toLocaleDateString()}
          timestampPreposition="on"
          rationale={decision.rationale}
          answers={decision.answers}
        />
      ) : data.isTracked && data.canDecide ? (
        <div className="rounded-xl border border-border-default bg-surface-inset/50 p-3.5">
          <DecisionActions
            workspaceId={data.workspaceId}
            revisionId={data.revisionId}
            fingerprint={data.fingerprint}
            options={data.options}
            questions={data.questions}
            onDecided={() => void load()}
          />
        </div>
      ) : data.isTracked ? (
        <section className="space-y-3 rounded-lg border border-border-default bg-surface-inset/40 p-3 text-sm text-muted-foreground">
          <p>Waiting for a workspace or organization admin to decide.</p>
          <DecisionQuestionList questions={data.questions} />
          {data.offeredChoices.length > 0 && (
            <ul className="space-y-2">
              {data.offeredChoices.map((o) => (
                <li key={o.id} className="rounded-md border border-border-default bg-background p-2">
                  <span className="block font-medium text-foreground break-words [overflow-wrap:anywhere]">{o.label}</span>
                  {o.description && <span className="block text-xs break-words [overflow-wrap:anywhere]">{o.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {(data.context ?? data.summary) && (
        <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Context</p>
          <DecisionLongForm content={data.context ?? data.summary} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
        <FullPageLink href={"/" + orgSlug + "/" + workspaceSlug + "/reviews/" + (data.displayId ?? data.id)} />
        {typeof data.sourcesCount === "number" && data.sourcesCount > 0 && (
          <span className="text-xs text-muted-foreground">
            {data.sourcesCount} {data.sourcesCount === 1 ? "source" : "sources"} on full page
          </span>
        )}
      </div>
    </PanelContainer>
  );
}
