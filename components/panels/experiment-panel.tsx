"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ExternalLinkIcon } from "lucide-react";

type ExperimentData = {
  id: string;
  title: string;
  status: string;
  hypothesis: string;
  method: string;
  killCondition: string;
  conclusion: string | null;
  startDate: string | null;
  endDate: string | null;
  assumption: { id: string; title: string; riskLevel: string } | null;
  results: Array<{ id: string; note: string; createdAt: string }>;
};

const STATUS_LABELS: Record<string, string> = {
  DESIGNING: "Designing",
  RUNNING: "Running",
  COMPLETE: "Complete",
  KILLED: "Killed",
};

const STATUS_CLASS: Record<string, string> = {
  DESIGNING: "bg-slate-100 text-slate-700",
  RUNNING: "bg-blue-100 text-blue-700",
  COMPLETE: "bg-green-100 text-green-700",
  KILLED: "bg-red-100 text-red-700",
};

const RISK_CLASS: Record<string, string> = {
  HIGH: "bg-red-100 text-red-700",
  MEDIUM: "bg-amber-100 text-amber-700",
  LOW: "bg-green-100 text-green-700",
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

  useEffect(() => {
    setData(null);
    setError(false);
    fetch(
      `/api/panels/entity/experiment/${experimentId}?orgSlug=${orgSlug}&workspaceSlug=${workspaceSlug}`
    )
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.json();
      })
      .then((res) => setData(res.data))
      .catch(() => setError(true));
  }, [experimentId, orgSlug, workspaceSlug]);

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
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge className={STATUS_CLASS[data.status] ?? "bg-slate-100 text-slate-700"}>
            {STATUS_LABELS[data.status] ?? data.status}
          </Badge>
          {data.conclusion && (
            <Badge variant="outline" className="text-xs">
              {data.conclusion}
            </Badge>
          )}
        </div>
        <h2 className="text-base font-semibold leading-snug">{data.title}</h2>
      </div>

      {/* Kill condition — prominent when active */}
      {isActive && (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-50 px-3.5 py-3 flex gap-2.5">
          <span className="text-lg text-amber-600 shrink-0" aria-hidden="true">⚠</span>
          <div>
            <p className="text-xs font-semibold text-amber-800 mb-0.5">Kill Condition</p>
            <p className="text-xs text-amber-900 leading-relaxed">{data.killCondition}</p>
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
            <Badge className={`${RISK_CLASS[data.assumption.riskLevel] ?? "bg-slate-100 text-slate-700"} shrink-0 text-xs`}>
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
        <blockquote className="border-l-4 border-muted pl-3 text-sm italic text-foreground/80 leading-relaxed">
          {data.hypothesis}
        </blockquote>
      </div>

      {/* Method */}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Method
        </p>
        <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
          {data.method}
        </p>
      </div>

      {/* Kill condition body (inactive experiments) */}
      {!isActive && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <span className="text-amber-500">⚠</span> Kill Condition
          </p>
          <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
            {data.killCondition}
          </p>
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
    </div>
  );
}
