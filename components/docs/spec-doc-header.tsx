import Link from "next/link";
import { specKindLabels, UNSCOPED_SPEC_LABEL } from "@/lib/spec-docs/labels";
import type { SpecScopeView } from "@/lib/spec-docs/view";

/**
 * What a SPEC doc is, shown above its body (spec docs phase 3): "Spec" for a solution, "Discovery Plan" for an opportunity, both when it is
 * linked to one of each, "Spec (unscoped)" plus an explanatory banner when its scope is gone. Read-only; the document is never changed here.
 */
export function SpecDocHeader({ scopes }: { scopes: SpecScopeView[] }) {
  const labels = specKindLabels(scopes.map((scope) => scope.scopeType));
  return (
    <div data-slot="spec-doc-header" className="mb-4 flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        {labels.map((label) => (
          <span key={label} data-slot="spec-doc-kind" className="rounded-full bg-status-info-surface px-2 py-0.5 text-xs font-medium text-status-info">
            {label}
          </span>
        ))}
        {scopes.map((scope) => (
          <Link key={`${scope.scopeType}:${scope.scopeId}`} href={scope.href} className="min-w-0 break-words text-sm text-text-secondary hover:text-text-primary hover:underline">
            {scope.scopeType === "SOLUTION" ? "Specifies solution" : "Plans opportunity"}: {scope.title}
          </Link>
        ))}
      </div>
      {scopes.length === 0 ? (
        <div role="status" data-slot="spec-doc-unscoped" className="rounded-md border border-status-warning bg-status-warning-surface px-3 py-2 text-sm text-status-warning">
          <span className="font-medium">{UNSCOPED_SPEC_LABEL}.</span> The solution or opportunity this document was written for no longer exists. The document is unchanged and its cards still show live data.
        </div>
      ) : null}
    </div>
  );
}
