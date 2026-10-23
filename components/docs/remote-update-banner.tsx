"use client";

/**
 * Shown when the server copy of a doc moved on while the editor holds unsaved work. The user's draft is never replaced silently:
 * Reload throws the draft away and adopts theirs; Keep mine makes the next save overwrite theirs on purpose.
 */
export function RemoteUpdateBanner({ writer, onReload, onKeepMine }: { writer: string; onReload: () => void; onKeepMine: () => void }) {
  return (
    <div role="alert" data-testid="remote-update-banner" className="mx-auto mb-2 flex w-full max-w-4xl flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-status-info/40 bg-status-info-surface px-3 py-2 text-xs text-text-primary">
      <span className="min-w-0 flex-1">
        Updated by {writer} while you were editing. Reload discards your unsaved changes; Keep mine overwrites their version when you next save.
      </span>
      <button type="button" className="rounded border border-border-default px-2 py-1 font-medium hover:bg-surface-inset" onClick={onReload}>Reload</button>
      <button type="button" className="rounded border border-border-default px-2 py-1 font-medium hover:bg-surface-inset" onClick={onKeepMine}>Keep mine</button>
    </div>
  );
}

/** Brief, polite confirmation that a clean editor picked up someone else's change. */
export function UpdatedJustNow() {
  return <span role="status" data-testid="doc-updated-just-now" className="text-xs text-text-subtle">Updated just now</span>;
}
