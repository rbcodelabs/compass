"use client";

import { useState, useTransition } from "react";
import { updateMemberWorkspaceReadOnlyAccess } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { Switch } from "@/components/ui/switch";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  memberWorkspaceReadOnlyAccess: boolean;
}

/**
 * Toggles Organization.memberWorkspaceReadOnlyAccess -- gates implicit
 * read-only access to EVERY workspace this organization owns for every
 * OrganizationMember, without a WorkspaceMember row. This page only renders
 * this panel for org OWNER/ADMIN (see settings/page.tsx's `isOrgAdmin`,
 * deliberately distinct from the workspace-admin gate the rest of this page
 * uses), and the server action re-checks the same thing -- the client gate is
 * a convenience, not the security boundary.
 *
 * Reverts the optimistic toggle and surfaces an inline error on failure
 * (e.g. a stale session that lost org-admin status mid-page-view) rather than
 * silently leaving the UI out of sync with the database, since this flag's
 * blast radius is every workspace in the org, not just this one.
 */
export function OrgReadOnlyAccessPanel({ orgSlug, workspaceSlug, memberWorkspaceReadOnlyAccess: initial }: Props) {
  const [enabled, setEnabled] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleToggle(value: boolean) {
    setEnabled(value);
    setError(null);
    startTransition(async () => {
      try {
        await updateMemberWorkspaceReadOnlyAccess(orgSlug, workspaceSlug, { memberWorkspaceReadOnlyAccess: value });
      } catch (err) {
        setEnabled(!value);
        setError(err instanceof Error ? err.message : "Failed to update this setting");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Give organization members read-only workspace access</span>
          <span className="text-xs text-muted-foreground">
            When on, every member of this organization can view every workspace it owns —
            Discovery, Roadmap, Docs, Feedback, OKRs, Experiments, Tasks, and more — without
            being added as a workspace member. They cannot create, edit, or delete anything, and
            cannot reach Settings, Members, or billing in any workspace. Off by default.
          </span>
        </div>
        <Switch
          data-testid="org-readonly-access-toggle"
          aria-label="Give organization members read-only workspace access"
          checked={enabled}
          disabled={isPending}
          onCheckedChange={handleToggle}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
