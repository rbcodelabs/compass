"use client";

import { useOkrFilter } from "@/components/okrs/okr-filter-context";
import { splitMatch } from "@/lib/okr-name-filter";

/**
 * Renders a title with the quick-filter match marked. Uses the status-warning
 * tokens so the mark has contrast in both light and dark themes.
 */
export function HighlightMatch({ text }: { text: string }) {
  const { query } = useOkrFilter();
  const parts = splitMatch(text, query);
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts.before}
      <mark className="rounded-sm bg-status-warning-surface px-0.5 text-status-warning underline decoration-status-warning underline-offset-2">
        {parts.match}
      </mark>
      {parts.after}
    </>
  );
}
