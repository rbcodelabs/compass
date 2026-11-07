"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { DecisionActions } from "@/components/decisions/decision-actions";
import { DecisionAnswerList, DecisionQuestionList } from "@/components/decisions/decision-answers";
import { DecisionLongForm } from "@/components/decisions/decision-long-form";
import type { TrackedDecisionAnswer, TrackedDecisionPacketQuestion } from "@/lib/tracked-decision-types";
import { FullPageLink, PanelContainer, PanelError, PanelSkeleton } from "./panel-parts";

type DecisionData = {
  id: string;
  workspaceId: string;
  state: string;
  isTracked: boolean;
  readOnlyLegacy: boolean;
  stale: boolean;
  title: string;
  summary: string | null;
  context: string | null;
  linkedTo: { type?: string; title?: string } | null;
  revisionId: string;
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
    decidedAt: string;
    rationale: string | null;
    answers: TrackedDecisionAnswer[];
  } | null;
};

/**
 * Sidebar view of a decision request: the question, its context, and (for admins) the controls to decide it.
 * Follow-through tasks, supporting artifacts and revision history stay on the full page.
 */
export function DecisionPanel({ id, orgSlug, workspaceSlug }: { id: string; orgSlug: string; workspaceSlug: string }) {
  const [data, setData] = useState(null as DecisionData | null);
  const [error, setError] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal) =>
      fetch("/api/panels/review/" + id + "?orgSlug=" + encodeURIComponent(orgSlug) + "&workspaceSlug=" + encodeURIComponent(workspaceSlug), { signal })
        .then((r) => {
          if (!r.ok) throw new Error("fetch failed");
          return r.json();
        })
        .then((res) => {
          setData(res.data as DecisionData);
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

  if (error) return <PanelError label="decision" />;
  if (!data) return <PanelSkeleton />;

  const decision = data.decision;
  return (
    <PanelContainer>
      <div className="flex flex-col items-start gap-2">
        <Badge className="bg-surface-inset text-text-secondary">{decision ? "Decided" : data.state === "PENDING" ? "Pending" : data.state.toLowerCase()}</Badge>
        <h2 className="text-base font-semibold leading-snug break-words [overflow-wrap:anywhere]">{data.title}</h2>
        {data.linkedTo?.title && <p className="text-xs text-muted-foreground">Linked to {data.linkedTo.title}</p>}
      </div>

      {(data.context ?? data.summary) && <DecisionLongForm content={data.context ?? data.summary} />}

      {data.readOnlyLegacy ? (
        <p className="rounded-lg border p-3 text-sm text-muted-foreground">This legacy review is read-only.</p>
      ) : data.stale && !decision ? (
        <p className="rounded-lg border p-3 text-sm text-muted-foreground">This request is stale and cannot be decided. A new revision is needed.</p>
      ) : decision ? (
        <section className="space-y-2 rounded-lg border bg-status-success-surface p-3 text-sm text-status-success">
          <p className="break-words [overflow-wrap:anywhere]">
            Decision recorded: <strong>{decision.label}</strong> by {decision.actorRole} on {new Date(decision.decidedAt).toLocaleDateString()}.
          </p>
          {decision.description && <p className="whitespace-pre-wrap text-foreground/80">{decision.description}</p>}
          <DecisionAnswerList answers={decision.answers} />
          <DecisionLongForm className="text-foreground" content={decision.rationale} />
        </section>
      ) : data.isTracked && data.canDecide ? (
        <DecisionActions
          workspaceId={data.workspaceId}
          revisionId={data.revisionId}
          fingerprint={data.fingerprint}
          options={data.options}
          questions={data.questions}
          onDecided={() => void load()}
        />
      ) : data.isTracked ? (
        <section className="space-y-3 rounded-lg border p-3 text-sm text-muted-foreground">
          <p>Waiting for a workspace or organization admin to decide.</p>
          <DecisionQuestionList questions={data.questions} />
          {data.offeredChoices.length > 0 && (
            <ul className="space-y-2">
              {data.offeredChoices.map((o) => (
                <li key={o.id} className="rounded-md border bg-background p-2">
                  <span className="block font-medium text-foreground">{o.label}</span>
                  {o.description && <span className="block text-xs">{o.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <FullPageLink href={"/" + orgSlug + "/" + workspaceSlug + "/reviews/" + data.id} />
    </PanelContainer>
  );
}
