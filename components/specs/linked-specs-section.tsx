"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/panels/panel-parts";
import type { EntityPanelType } from "@/components/panels/panel-context";
import { createSpec, loadScopeSpecs } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { SPEC_KIND_LABEL } from "@/lib/spec-docs/labels";
import type { SpecScopeType } from "@/lib/spec-docs/scopes";
import type { SpecListItem } from "@/lib/spec-docs/view";

type Loaded = { workspaceId: string; canCreate: boolean; specs: SpecListItem[] };

// The scope's own name comes from the workspace's thinking model (a workspace may call a Solution something else); "Spec" and
// "Discovery Plan" are the document kinds and are fixed.
const COPY: Record<SpecScopeType, { section: string; newLabel: string; noun: string }> = {
  SOLUTION: { section: "Specs", newLabel: "New spec", noun: "spec" },
  OPPORTUNITY: { section: "Discovery Plans", newLabel: "New plan", noun: "discovery plan" },
};

/**
 * The "Specs" section of a solution and the "Discovery Plans" section of an opportunity (spec docs phase 3). Lists every spec linked to the
 * scope, newest update first: a scope can have many, so nothing here assumes one. "New spec" / "New plan" always makes another doc (an
 * explicit action; opening this section never creates anything) and is offered only to members who can write.
 */
export function LinkedSpecsSection({
  scopeType,
  scopeId,
  orgSlug,
  workspaceSlug,
  collapsible,
  panelType,
}: {
  scopeType: SpecScopeType;
  scopeId: string;
  orgSlug: string;
  workspaceSlug: string;
  collapsible?: boolean;
  panelType?: EntityPanelType;
}) {
  const copy = COPY[scopeType];
  const labels = useLabels();
  const empty = scopeType === "SOLUTION" ? `No specs for this ${labels.solution.lower} yet.` : `No discovery plans for this ${labels.opportunity.lower} yet.`;
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, startCreating] = useTransition();

  const load = useCallback(() => {
    loadScopeSpecs(orgSlug, workspaceSlug, scopeType, scopeId).then(setLoaded, () => setLoadFailed(true));
  }, [orgSlug, workspaceSlug, scopeType, scopeId]);
  useEffect(load, [load]);

  const create = () => {
    if (!loaded) return;
    setCreateError(null);
    startCreating(async () => {
      try {
        const result = await createSpec(loaded.workspaceId, scopeType, scopeId, `/${orgSlug}/${workspaceSlug}`);
        if ("error" in result) setCreateError(result.error);
        else router.push(`/${orgSlug}/${workspaceSlug}/docs/${result.docId}`);
      } catch {
        setCreateError(`Could not create the ${copy.noun}. Try again.`);
      }
    });
  };

  return (
    <Section label={copy.section} count={loaded?.specs.length} collapsible={collapsible} panelType={panelType} defaultOpen>
      <div data-slot="linked-specs" data-scope-type={scopeType} className="flex min-w-0 flex-col gap-2">
        {loadFailed ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {`Could not load ${copy.section.toLowerCase()}. `}
            <button type="button" className="underline" onClick={() => { setLoadFailed(false); load(); }}>Retry</button>
          </p>
        ) : !loaded ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {loaded.specs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{empty}</p>
            ) : (
              <ul className="flex min-w-0 flex-col divide-y divide-border-default rounded-md border border-border-default">
                {loaded.specs.map((spec) => (
                  <li key={spec.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2">
                    <Link href={spec.href} className="min-w-0 break-words text-sm font-medium text-foreground hover:underline">
                      {spec.title}
                    </Link>
                    {spec.label ? <span className="rounded-full bg-status-neutral-surface px-2 py-0.5 text-xs text-status-neutral">{spec.label}</span> : null}
                    <time dateTime={spec.updatedAt} className="ml-auto text-xs text-muted-foreground">
                      {`Updated ${spec.updatedAt.slice(0, 10)}`}
                    </time>
                  </li>
                ))}
              </ul>
            )}
            {loaded.canCreate ? (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={create} disabled={creating}>
                  {creating ? `Creating ${SPEC_KIND_LABEL[scopeType].toLowerCase()}…` : copy.newLabel}
                </Button>
              </div>
            ) : null}
            {createError ? <p role="alert" className="text-sm text-destructive">{createError}</p> : null}
          </>
        )}
      </div>
    </Section>
  );
}
