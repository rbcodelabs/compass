"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteOrganization } from "@/app/[orgSlug]/settings/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  orgSlug: string;
  organizationName: string;
  workspaces: { name: string }[];
}

export function DeleteOrganizationPanel({ orgSlug, organizationName, workspaces }: Props) {
  const router = useRouter();
  const [confirmName, setConfirmName] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const confirmed = confirmName === organizationName;

  function handleDelete() {
    if (!confirmed || isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteOrganization(orgSlug, confirmName);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(result.redirectTo);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-status-danger/30 bg-status-danger-surface px-4 py-4">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-status-danger">
          Delete this organization
        </span>
        <p className="text-sm text-status-danger">
          This permanently deletes <strong>{organizationName}</strong> and everything in
          it. This action cannot be undone.
        </p>
        {workspaces.length > 0 ? (
          <p className="text-sm text-status-danger">
            The following {workspaces.length}{" "}
            {workspaces.length === 1 ? "workspace" : "workspaces"} will be deleted, along
            with all of their OKRs, opportunities, experiments, roadmap items, docs, and
            feedback:
          </p>
        ) : (
          <p className="text-sm text-status-danger">
            This organization has no workspaces. Deleting it removes its scoring models
            and members.
          </p>
        )}
        {workspaces.length > 0 && (
          <ul className="ml-4 list-disc space-y-0.5 text-sm text-status-danger">
            {workspaces.map((ws) => (
              <li key={ws.name} className="break-words font-medium">
                {ws.name}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="confirm-org-name" className="text-sm font-medium text-status-danger">
          Type <span className="font-mono font-semibold">{organizationName}</span> to
          confirm
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            id="confirm-org-name"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder={organizationName}
            disabled={isPending}
            autoComplete="off"
            className="sm:max-w-xs"
          />
          <Button
            type="button"
            variant="destructive"
            disabled={!confirmed || isPending}
            onClick={handleDelete}
            className="shrink-0"
          >
            {isPending ? "Deleting…" : "Delete organization"}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
