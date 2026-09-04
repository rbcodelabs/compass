import { MarkdownContent } from "@/components/markdown-content";
import type { ReactNode } from "react";

export function DecisionDetailsGrid({ children }: { children: ReactNode }) {
  return <dl data-testid="decision-details-grid" className="grid grid-cols-1 gap-x-2 gap-y-1 sm:grid-cols-[10rem_1fr] sm:gap-y-2 [&_dt]:font-medium [&_dd]:mb-3 [&_dd]:min-w-0 sm:[&_dd]:mb-0">{children}</dl>;
}

export function DecisionLongForm({ content, className }: { content: string | null | undefined; className?: string }) {
  return content ? <MarkdownContent className={className}>{content}</MarkdownContent> : null;
}

export function DecisionSummary({ tracked, summary }: { tracked: boolean; summary: string | null | undefined }) {
  return tracked ? null : <DecisionLongForm className="mt-2 text-muted-foreground" content={summary} />;
}
