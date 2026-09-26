"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deleteEvidence } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { researchStudyHref, researchTurnHref } from "@/lib/research-turn-link";
import type { EvidenceProvenance } from "@/lib/evidence-provenance";
import type { EvidenceSourceType, EvidenceConfidence } from "@/lib/types";

export type EvidenceListItem = {
  id: string;
  sourceType: EvidenceSourceType;
  excerpt: string;
  sourceUrl: string | null;
  confidence: EvidenceConfidence;
  createdAt: string | Date;
  /**
   * ADR-0012 step 6a. Present only on rows `promote_research_finding_to_evidence`
   * created; absent for every pre-052 row and everything `add_evidence` makes.
   * Optional rather than nullable so those rows keep the exact object shape —
   * and the exact rendered markup — they had before provenance existed.
   */
  research?: EvidenceProvenance;
};

const SOURCE_TYPE_LABELS: Record<EvidenceSourceType, string> = {
  interview: "Interview",
  feedback: "Feedback",
  support_ticket: "Support Ticket",
  experiment_result: "Experiment Result",
  analytics: "Analytics",
};

const CONFIDENCE_CLASSES: Record<EvidenceConfidence, string> = {
  high: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  low: "bg-surface-inset text-text-secondary",
};

type Props = {
  evidence: EvidenceListItem[];
  revalidatePathStr: string;
  /** Needed to build capture deep links; every Evidence surface is already
   * inside an `/[orgSlug]/[workspaceSlug]/` route, so both are always known. */
  orgSlug: string;
  workspaceSlug: string;
  onMutated?: () => void;
};

/**
 * The citation trail for one promoted finding (ADR-0012 step 6a).
 *
 * Each source links through `?turnId=` on the study page rather than straight
 * to a session — the same route `components/research/analysis-results.tsx`
 * uses. That page re-checks workspace membership and study scope, resolves
 * which session holds the turn, and redirects to it anchored, so the link
 * needs no session id and cannot be used to probe another workspace.
 *
 * Renders nothing when `research` is absent, which is what keeps every
 * non-promoted row's markup unchanged.
 */
function EvidenceProvenanceTrail({
  research,
  orgSlug,
  workspaceSlug,
}: {
  research: EvidenceProvenance;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const count = research.sources.length;
  return (
    <div
      data-testid="evidence-provenance"
      className="mt-1 rounded-lg border border-border/50 bg-background/40 px-2.5 py-1.5"
    >
      <p className="text-xs text-muted-foreground">
        Promoted from a research synthesis · cites {count} saved{" "}
        {count === 1 ? "turn" : "turns"}
      </p>
      <ul className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        {research.sources.map((source, index) => (
          <li key={source.researchTurnId} className="text-xs">
            {source.resolved && source.studyId ? (
              <Link
                href={researchTurnHref(
                  researchStudyHref(orgSlug, workspaceSlug, source.studyId),
                  source.researchTurnId
                )}
                className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Source {index + 1}
              </Link>
            ) : (
              // Provenance rot: EvidenceResearchSource has no foreign key (DSQL
              // has none), so a deleted turn leaves a citation pointing nowhere.
              // Saying so beats silently showing one source where two were cited.
              <span className="italic text-muted-foreground">
                Source {index + 1} — turn no longer saved
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EvidenceList({
  evidence: initialEvidence,
  revalidatePathStr,
  orgSlug,
  workspaceSlug,
  onMutated,
}: Props) {
  const [evidence, setEvidence] = useState(initialEvidence);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setEvidence(initialEvidence);
  }, [initialEvidence]);

  function handleDelete(id: string) {
    setEvidence((prev) => prev.filter((e) => e.id !== id));
    startTransition(async () => {
      await deleteEvidence(id, revalidatePathStr);
      onMutated?.();
    });
  }

  if (evidence.length === 0) {
    return <p className="text-sm text-muted-foreground">No evidence yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2" aria-busy={isPending}>
      {evidence.map((item) => (
        <div
          key={item.id}
          data-evidence-id={item.id}
          className="group flex items-start gap-3 rounded-xl border border-border/60 bg-muted/20 px-3.5 py-3 hover:border-border transition-colors"
        >
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge variant="secondary">{SOURCE_TYPE_LABELS[item.sourceType]}</Badge>
              <span
                className={`inline-flex h-5 items-center rounded-4xl px-2 text-xs font-medium ${CONFIDENCE_CLASSES[item.confidence]}`}
              >
                {item.confidence}
              </span>
            </div>
            <p className="text-sm text-foreground/90 leading-snug">{item.excerpt}</p>
            <div className="flex items-center gap-2 mt-0.5">
              {item.sourceUrl && (
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 truncate max-w-[240px]"
                >
                  {item.sourceUrl}
                </a>
              )}
              <span className="text-xs text-muted-foreground">
                {new Date(item.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            </div>
            {item.research && (
              <EvidenceProvenanceTrail
                research={item.research}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
              />
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
            disabled={isPending}
            onClick={() => handleDelete(item.id)}
            aria-label="Delete evidence"
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
