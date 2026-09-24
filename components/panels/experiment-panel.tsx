"use client";
import { Discussion } from "@/components/comments/discussion";
import { RequestDecisionLink } from "@/components/decisions/request-decision-link";
import { FleshThisOutLink } from "@/components/research/flesh-this-out-link";
import { PmInterviewHistory } from "@/components/research/pm-interview-history";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ExternalLinkIcon } from "lucide-react";
import { EditableText, StatusSelect, type EditContext } from "./panel-parts";
import { MarkdownContent } from "@/components/markdown-content";
import { LinkedTasksSection, type LinkedTaskData } from "@/components/tasks/linked-tasks-section";
import type { MemberData } from "@/lib/types";
import { ExperimentResearchLinksSection } from "@/components/research/experiment-research-links-section";
import { MeasurementsPanel } from "@/components/analytics/measurements-panel";

type ExperimentData = {
  id: string;
  pmInterviews: Array<{ id: string; disposition: string; generationState: string; createdAt: string }>;
  pmInterviewEnabled?: boolean;
  researchCaptureEnabled?: boolean;
  title: string;
  status: string;
  hypothesis: string;
  method: string;
  killCondition: string;
  conclusion: string | null;
  conclusionReason: string | null;
  startDate: string | null;
  endDate: string | null;
  assumption: { id: string; title: string; riskLevel: string } | null;
  results: Array<{ id: string; note: string; createdAt: string }>;
  deliveryTasks: LinkedTaskData[];
  linkableTasks: Array<{ id: string; title: string }>;
  members: MemberData[];
};

const STATUS_LABELS: Record<string, string> = {
  DESIGNING: "Designing",
  RUNNING: "Running",
  COMPLETE: "Complete",
  KILLED: "Killed",
  NOT_PURSUED: "Not Pursued",
};

const STATUS_CLASS: Record<string, string> = {
  DESIGNING: "bg-surface-inset text-text-secondary",
  RUNNING: "bg-blue-100 text-blue-700",
  COMPLETE: "bg-green-100 text-green-700",
  KILLED: "bg-red-100 text-red-700",
  // Neutral, distinct from KILLED's red — a deliberate non-pursuit, not a
  // tested-and-failed experiment.
  NOT_PURSUED: "bg-surface-inset text-text-secondary",
};

const RISK_CLASS: Record<string, string> = {
  HIGH: "bg-red-100 text-red-700",
  MEDIUM: "bg-amber-100 text-amber-700",
  LOW: "bg-green-100 text-green-700",
};

const STATUS_MAP: Record<string, { label: string; className: string }> = {
  DESIGNING: { label: STATUS_LABELS.DESIGNING, className: STATUS_CLASS.DESIGNING },
  RUNNING: { label: STATUS_LABELS.RUNNING, className: STATUS_CLASS.RUNNING },
  COMPLETE: { label: STATUS_LABELS.COMPLETE, className: STATUS_CLASS.COMPLETE },
  KILLED: { label: STATUS_LABELS.KILLED, className: STATUS_CLASS.KILLED },
  // Intentionally NOT in STATUS_ORDER below — NOT_PURSUED is only reachable
  // through the deliberate Conclude flow (which captures a reason and
  // cascades the linked Assumption), never through this raw quick-edit
  // status dropdown. Still mapped here so it renders correctly once set.
  NOT_PURSUED: { label: STATUS_LABELS.NOT_PURSUED, className: STATUS_CLASS.NOT_PURSUED },
};
const STATUS_ORDER = ["DESIGNING", "RUNNING", "COMPLETE", "KILLED"] as const;

// Semantic status tokens rather than raw palette values: they already carry
// their own dark-mode values, so no `dark:` variants are needed. NOT_PURSUED is
// neutral on purpose — it means "never tested", which is distinct from KILL's
// "tested and invalidated".
const CONCLUSION_CLASS: Record<string, string> = {
  PROCEED: "border-status-success/30 text-status-success",
  KILL: "border-status-danger/30 text-status-danger",
  ITERATE: "border-status-warning/30 text-status-warning",
  NOT_PURSUED: "border-status-neutral/30 text-status-neutral",
};

export function ExperimentPanel({
  experimentId,
  orgSlug,
  workspaceSlug,
}: {
  experimentId: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const [data, setData] = useState<ExperimentData | null>(null);
  const [error, setError] = useState(false);

  // Refetch without clearing current data — same shape as panel-parts'
  // useEntityDetail, kept local here since this panel predates that hook and
  // has its own manual fetch effect below.
  const refresh = useCallback(() => {
    return fetch(
      `/api/panels/entity/experiment/${experimentId}?orgSlug=${orgSlug}&workspaceSlug=${workspaceSlug}`
    )
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.json();
      })
      .then((res) => setData(res.data))
      .catch(() => setError(true));
  }, [experimentId, orgSlug, workspaceSlug]);

  useEffect(() => {
    setData(null);
    setError(false);
    refresh();
  }, [refresh]);

  const fullPageHref = `/${orgSlug}/${workspaceSlug}/experiments/${experimentId}`;

  if (error) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        Could not load experiment.
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-4 px-5 pt-2 animate-pulse">
        <div className="h-4 w-2/3 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-5/6 rounded bg-muted" />
        <div className="h-3 w-4/6 rounded bg-muted" />
      </div>
    );
  }

  const isActive = data.status === "RUNNING" || data.status === "DESIGNING";

  const edit: EditContext = {
    type: "experiment",
    id: experimentId,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => setData(d as ExperimentData),
  };

  return (
    <div className="flex flex-col gap-5 px-5 pb-8 overflow-y-auto">
      {/* Open full page link */}
      <Link
        href={fullPageHref}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit"
      >
        <ExternalLinkIcon className="size-3" />
        Open full page
      </Link>

      {/* Status + title */}
      <div className="flex flex-col gap-2 items-start">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusSelect
            value={data.status}
            field="status"
            options={STATUS_ORDER}
            map={STATUS_MAP}
            edit={edit}
          />
          {data.conclusion && (
            <Badge variant="outline" className={`text-xs ${CONCLUSION_CLASS[data.conclusion] ?? ""}`}>
              {data.conclusion === "NOT_PURSUED" ? "Not Pursued" : data.conclusion}
            </Badge>
          )}
        </div>
        <EditableText
          value={data.title}
          field="title"
          edit={edit}
          className="text-base font-semibold leading-snug w-full"
        />
      </div>
      {data.conclusionReason && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground mb-0.5">Reason</p>
          <p className="text-sm text-foreground/80 whitespace-pre-wrap">{data.conclusionReason}</p>
        </div>
      )}
      <RequestDecisionLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} subjectType="EXPERIMENT" subjectId={data.id} subjectTitle={data.title} />
      <MeasurementsPanel orgSlug={orgSlug} workspaceSlug={workspaceSlug} target={{ targetType: "EXPERIMENT", targetId: data.id }} compact />
      {data.pmInterviewEnabled && <FleshThisOutLink orgSlug={orgSlug} workspaceSlug={workspaceSlug} targetType="EXPERIMENT" targetId={experimentId} />}

      {/* Kill condition — prominent when active */}
      {isActive && (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-50 px-3.5 py-3 flex gap-2.5">
          <span className="text-lg text-amber-600 shrink-0" aria-hidden="true">⚠</span>
          <div>
            <p className="text-xs font-semibold text-amber-800 mb-0.5">Kill Condition</p>
            <MarkdownContent className="text-xs text-amber-900">{data.killCondition}</MarkdownContent>
          </div>
        </div>
      )}

      <Separator />

      {/* Linked assumption */}
      {data.assumption && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Testing Assumption
          </p>
          <div className="flex items-start gap-2">
            <Badge className={`${RISK_CLASS[data.assumption.riskLevel] ?? "bg-surface-inset text-text-secondary"} shrink-0 text-xs`}>
              {data.assumption.riskLevel}
            </Badge>
            <p className="text-sm leading-snug">{data.assumption.title}</p>
          </div>
        </div>
      )}

      {/* Hypothesis */}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Hypothesis
        </p>
        <MarkdownContent className="border-l-4 border-muted pl-3 italic text-foreground/80">{data.hypothesis}</MarkdownContent>
      </div>

      {/* Method */}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Method
        </p>
        <MarkdownContent className="text-foreground/80">{data.method}</MarkdownContent>
      </div>

      {data.researchCaptureEnabled && <ExperimentResearchLinksSection orgSlug={orgSlug} workspaceSlug={workspaceSlug} target={{ type: "experiment", id: experimentId }} />}

      {/* Kill condition body (inactive experiments) */}
      {!isActive && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <span className="text-amber-500">⚠</span> Kill Condition
          </p>
          <MarkdownContent className="text-foreground/80">{data.killCondition}</MarkdownContent>
        </div>
      )}

      <Separator />

      {/* Results */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Results{" "}
          {data.results.length > 0 && (
            <span className="normal-case font-normal">({data.results.length})</span>
          )}
        </p>
        {data.results.length === 0 ? (
          <p className="text-sm text-muted-foreground">No results logged yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {data.results.slice(-3).map((r) => (
              <div key={r.id} className="rounded-md bg-muted/50 px-3 py-2">
                <p className="text-xs text-muted-foreground mb-0.5">
                  {new Date(r.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </p>
                <p className="text-sm leading-snug line-clamp-3">{r.note}</p>
              </div>
            ))}
            {data.results.length > 3 && (
              <Link
                href={fullPageHref}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                + {data.results.length - 3} more — open full page
              </Link>
            )}
          </div>
        )}
      </div>
      <Separator />

      {/* Delivery tasks */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Delivery Tasks{" "}
          {data.deliveryTasks.length > 0 && (
            <span className="normal-case font-normal">({data.deliveryTasks.length})</span>
          )}
        </p>
        <LinkedTasksSection
          linkedType="EXPERIMENT"
          linkedId={data.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          revalidatePathStr={fullPageHref}
          tasks={data.deliveryTasks}
          linkableTasks={data.linkableTasks}
          members={data.members}
          onChanged={refresh}
        />
      </div>

      <PmInterviewHistory orgSlug={orgSlug} workspaceSlug={workspaceSlug} interviews={data.pmInterviews} />
      <Discussion targetType="EXPERIMENT" targetId={experimentId} />
    </div>
  );
}
