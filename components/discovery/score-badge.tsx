"use client";

import Link from "next/link";
import { AlertTriangleIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { OpportunityScoreSummary } from "@/lib/types";

type Props = {
  /** null / undefined means "this opportunity has no saved score". */
  score: OpportunityScoreSummary | null | undefined;
  /** Deep link to this opportunity's Scoring tab. */
  scoringHref: string;
  className?: string;
};

/**
 * Score affordance for an opportunity card.
 *
 * Callers must only render this when the workspace has an active scoring
 * model — with no model there is no meaningful score and no place to set one,
 * so the board shows nothing at all (same gate as the detail page's Scoring
 * tab).
 *
 * Three states:
 *  - scored        → "Score 72" badge (normalizedScore is a float; rounded here)
 *  - scored, stale → same badge plus a warning icon + tooltip naming both versions
 *  - unscored      → subtle "Not scored" link straight to the Scoring tab
 */
export function ScoreBadge({ score, scoringHref, className }: Props) {
  if (!score) {
    return (
      <Link
        href={scoringHref}
        data-slot="opportunity-not-scored"
        className={`inline-flex h-5 items-center rounded-4xl border border-dashed border-border-default px-2 text-xs font-medium text-text-subtle transition-colors hover:border-border-strong hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus ${className ?? ""}`}
      >
        Not scored
      </Link>
    );
  }

  const rounded = Math.round(score.normalizedScore);

  if (!score.stale) {
    return (
      <Badge
        variant="secondary"
        data-slot="opportunity-score"
        className={className}
        aria-label={`Score ${rounded} out of 100`}
      >
        Score {rounded}
      </Badge>
    );
  }

  const staleExplanation = `Scored under v${score.modelVersion} of the scoring model; the live version is v${score.liveModelVersion}. Re-save on the Scoring tab to refresh it.`;

  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge
              variant="secondary"
              data-slot="opportunity-score"
              data-stale="true"
              className={className}
              aria-label={`Score ${rounded} out of 100 (stale). ${staleExplanation}`}
            />
          }
        >
          <AlertTriangleIcon
            data-slot="opportunity-score-stale"
            className="size-3 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          Score {rounded}
        </TooltipTrigger>
        <TooltipContent side="bottom">{staleExplanation}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
