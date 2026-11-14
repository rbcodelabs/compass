import Link from "next/link";
import { StatusBadge } from "@/components/patterns/status-badge";
import { docKindLabel } from "@/lib/doc-kinds";
import { LIBRARY_LATEST_LIMIT, type KindCounts, type KindGroup, type LibraryDoc } from "@/lib/docs-library";

/**
 * The three Docs library views. Server-renderable (no hooks): the page loads the workspace's docs and hands them in.
 *
 * Rows are stacked on a phone (title on its own line, kind and date under it) and sit side by side from `sm` up, so a long title wraps
 * instead of being squeezed beside its date and nothing needs a horizontal scrollbar at 390px.
 *
 * Known scale limit (stage 1): the page loads every doc in the workspace and By Type renders every row without pagination, while
 * Recent is capped at LIBRARY_LATEST_LIMIT with no "showing N of M" hint. That is fine at tens of docs; revisit before a workspace
 * holds thousands.
 */

// A fixed locale and zone, so the server and the browser never disagree about the day a doc was updated.
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function DocRow({ doc, basePath, showKind }: { doc: LibraryDoc; basePath: string; showKind: boolean }) {
  return (
    <li>
      <Link
        href={`${basePath}/${doc.id}`}
        className="flex flex-col gap-1 px-4 py-3 transition-colors hover:bg-surface-interactive-hover focus-visible:bg-surface-interactive-hover focus-visible:outline-none sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
      >
        <span className="min-w-0 break-words text-sm font-medium text-text-primary">{doc.title.trim() || "Untitled"}</span>
        <span className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-text-subtle">
          {showKind && <StatusBadge status={doc.kind ? "info" : "neutral"}>{docKindLabel(doc.kind)}</StatusBadge>}
          <time dateTime={doc.updatedAt.toISOString()}>{dateFormat.format(doc.updatedAt)}</time>
        </span>
      </Link>
    </li>
  );
}

function DocList({ docs, basePath, showKind, testId }: { docs: readonly LibraryDoc[]; basePath: string; showKind: boolean; testId?: string }) {
  return (
    <ul data-testid={testId} className="divide-y divide-border-default overflow-hidden rounded-xl border border-border-default bg-surface-card">
      {docs.map((doc) => (
        <DocRow key={doc.id} doc={doc} basePath={basePath} showKind={showKind} />
      ))}
    </ul>
  );
}

export function LibraryOverview({ counts, latest, basePath }: { counts: KindCounts; latest: readonly LibraryDoc[]; basePath: string }) {
  const tiles = [
    ...counts.byKind.map(({ kind, label, count }) => ({ id: kind as string, label, count })),
    { id: "none", label: docKindLabel(null), count: counts.noType },
  ];
  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 sm:px-6">
      <section aria-labelledby="library-types-heading" className="space-y-3">
        <h2 id="library-types-heading" className="text-sm font-semibold text-text-primary">Types</h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {tiles.map((tile) => (
            <li key={tile.id}>
              <Link
                href={`${basePath}?view=by-type`}
                data-testid={`library-kind-count-${tile.id}`}
                data-count={tile.count}
                className="flex min-h-20 flex-col justify-between gap-2 rounded-xl border border-border-default bg-surface-card p-4 transition-colors hover:border-border-strong focus-visible:border-border-focus focus-visible:outline-none"
              >
                <span className="text-xs font-medium text-text-subtle">{tile.label}</span>
                <span className="text-2xl font-semibold tabular-nums text-text-primary">{tile.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="library-latest-heading" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="library-latest-heading" className="text-sm font-semibold text-text-primary">Recently updated</h2>
          <Link href={`${basePath}?view=recent`} className="text-xs font-medium text-text-subtle hover:text-text-primary">See all recent</Link>
        </div>
        <DocList docs={latest.slice(0, LIBRARY_LATEST_LIMIT)} basePath={basePath} showKind testId="library-latest" />
      </section>
    </div>
  );
}

export function LibraryByType({ groups, basePath }: { groups: readonly KindGroup[]; basePath: string }) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 sm:px-6">
      {groups.map((group) => (
        <section key={group.kind ?? "none"} data-testid={`library-group-${group.kind ?? "none"}`} aria-labelledby={`library-group-${group.kind ?? "none"}-heading`} className="space-y-3">
          <h2 id={`library-group-${group.kind ?? "none"}-heading`} className="flex items-baseline gap-2 text-sm font-semibold text-text-primary">
            {group.label}
            <span className="text-xs font-normal tabular-nums text-text-subtle">{group.docs.length}</span>
          </h2>
          <DocList docs={group.docs} basePath={basePath} showKind={false} />
        </section>
      ))}
    </div>
  );
}

export function LibraryRecent({ docs, basePath }: { docs: readonly LibraryDoc[]; basePath: string }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <DocList docs={docs} basePath={basePath} showKind testId="library-recent-list" />
    </div>
  );
}
