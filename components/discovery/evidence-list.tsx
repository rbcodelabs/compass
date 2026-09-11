"use client";

import { useEffect, useState, useTransition } from "react";
import { Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deleteEvidence } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { EvidenceSourceType, EvidenceConfidence } from "@/lib/types";

export type EvidenceListItem = {
  id: string;
  sourceType: EvidenceSourceType;
  excerpt: string;
  sourceUrl: string | null;
  confidence: EvidenceConfidence;
  createdAt: string | Date;
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
  low: "bg-surface-inset text-text-secondary dark:bg-slate-800/50 dark:text-text-subtle",
};

type Props = {
  evidence: EvidenceListItem[];
  revalidatePathStr: string;
};

export function EvidenceList({ evidence: initialEvidence, revalidatePathStr }: Props) {
  const [evidence, setEvidence] = useState(initialEvidence);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setEvidence(initialEvidence);
  }, [initialEvidence]);

  function handleDelete(id: string) {
    setEvidence((prev) => prev.filter((e) => e.id !== id));
    startTransition(async () => {
      await deleteEvidence(id, revalidatePathStr);
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
