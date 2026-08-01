"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ExternalLinkIcon } from "lucide-react";
import { EvidenceList, type EvidenceListItem } from "@/components/discovery/evidence-list";
import { AddEvidenceDialog } from "@/components/discovery/add-evidence-dialog";
import { EditableText, StatusSelect, type EditContext } from "./panel-parts";

type OpportunityData = {
  id: string;
  title: string;
  status: string;
  description: string | null;
  customerSegment: string | null;
  workspaceId: string;
  linkedKeyResult: {
    id: string;
    title: string;
    current: number;
    target: number;
    unit: string | null;
    objective: { title: string; cycleId: string } | null;
  } | null;
  solutions: Array<{ id: string; title: string; status: string }>;
  evidence: EvidenceListItem[];
};

// Matches the actual Opportunity status enum (see lib/entity-mutations.ts /
// opportunity-card). The panel previously carried a stale set (VALIDATED /
// DEPRIORITIZED) that never matched real data.
const STATUS_MAP: Record<string, { label: string; className: string }> = {
  EXPLORING: { label: "Exploring", className: "bg-violet-100 text-violet-700" },
  VALIDATING: { label: "Validating", className: "bg-blue-100 text-blue-700" },
  PRIORITIZED: { label: "Prioritized", className: "bg-indigo-100 text-indigo-700" },
  ACTIVE: { label: "Active", className: "bg-green-100 text-green-700" },
  ARCHIVED: { label: "Archived", className: "bg-slate-100 text-slate-500" },
};
const STATUS_ORDER = ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"] as const;

const SOLUTION_STATUS_CLASS: Record<string, string> = {
  IDEA: "bg-slate-100 text-slate-600",
  SELECTED: "bg-blue-100 text-blue-700",
  SHIPPED: "bg-green-100 text-green-700",
  KILLED: "bg-red-100 text-red-700",
};

export function OpportunityPanel({
  opportunityId,
  orgSlug,
  workspaceSlug,
}: {
  opportunityId: string;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const [data, setData] = useState<OpportunityData | null>(null);
  const [error, setError] = useState(false);

  function refresh() {
    return fetch(
      `/api/panels/entity/opportunity/${opportunityId}?orgSlug=${orgSlug}&workspaceSlug=${workspaceSlug}`
    )
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.json();
      })
      .then((res) => setData(res.data))
      .catch(() => setError(true));
  }

  useEffect(() => {
    setData(null);
    setError(false);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opportunityId]);

  const fullPageHref = `/${orgSlug}/${workspaceSlug}/discovery/${opportunityId}`;

  if (error) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        Could not load opportunity.
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

  const edit: EditContext = {
    type: "opportunity",
    id: opportunityId,
    orgSlug,
    workspaceSlug,
    onSaved: (d) => setData(d as OpportunityData),
  };

  const krProgress =
    data.linkedKeyResult && data.linkedKeyResult.target > 0
      ? Math.round((data.linkedKeyResult.current / data.linkedKeyResult.target) * 100)
      : null;

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
        <StatusSelect
          value={data.status}
          field="status"
          options={STATUS_ORDER}
          map={STATUS_MAP}
          edit={edit}
        />
        <EditableText
          value={data.title}
          field="title"
          edit={edit}
          className="text-base font-semibold leading-snug w-full"
        />
      </div>

      {/* Description */}
      <EditableText
        value={data.description}
        field="description"
        edit={edit}
        multiline
        placeholder="Add a description…"
        className="text-sm text-foreground/80 leading-relaxed"
      />

      {data.customerSegment && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Customer Segment
          </p>
          <p className="text-sm">{data.customerSegment}</p>
        </div>
      )}

      <Separator />

      {/* Linked KR */}
      {data.linkedKeyResult ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Driving Key Result
          </p>
          {data.linkedKeyResult.objective && (
            <p className="text-xs text-muted-foreground">
              {data.linkedKeyResult.objective.title}
            </p>
          )}
          <p className="text-sm font-medium leading-snug">
            {data.linkedKeyResult.title}
          </p>
          {krProgress !== null && (
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-all"
                  style={{ width: `${Math.min(krProgress, 100)}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">
                {data.linkedKeyResult.current}/{data.linkedKeyResult.target}
                {data.linkedKeyResult.unit ? ` ${data.linkedKeyResult.unit}` : ""}
              </span>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No key result linked.</p>
      )}

      <Separator />

      {/* Solutions */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Solutions{" "}
          {data.solutions.length > 0 && (
            <span className="normal-case font-normal">({data.solutions.length})</span>
          )}
        </p>
        {data.solutions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No solutions yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {data.solutions.map((sol) => (
              <div key={sol.id} className="flex items-start gap-2">
                <Badge
                  className={`${SOLUTION_STATUS_CLASS[sol.status] ?? "bg-slate-100 text-slate-600"} shrink-0 text-xs`}
                >
                  {sol.status}
                </Badge>
                <p className="text-sm leading-snug">{sol.title}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* Evidence */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Evidence{" "}
            {data.evidence.length > 0 && (
              <span className="normal-case font-normal">({data.evidence.length})</span>
            )}
          </p>
        </div>
        <AddEvidenceDialog
          workspaceId={data.workspaceId}
          nodeType="opportunity"
          nodeId={data.id}
          revalidatePathStr={fullPageHref}
          onMutated={refresh}
        />
        <EvidenceList evidence={data.evidence} revalidatePathStr={fullPageHref} />
      </div>
    </div>
  );
}
