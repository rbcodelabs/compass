"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteWorkspace } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  workspaceName: string;
}

export function DeleteWorkspacePanel({ orgSlug, workspaceSlug, workspaceName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const confirmed = confirmName === workspaceName;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setConfirmName("");
      setError(null);
    }
    setOpen(next);
  }

  function handleDelete() {
    if (!confirmed) return;
    setError(null);
    startTransition(async () => {
      try {
        const { redirectTo } = await deleteWorkspace(orgSlug, workspaceSlug);
        router.push(redirectTo);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-red-900">Delete this workspace</span>
          <span className="text-xs text-red-700">
            Permanently removes this workspace and all its data. This action cannot be undone.
          </span>
        </div>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setOpen(true)}
        >
          Delete workspace
        </Button>
      </div>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Delete workspace</DialogTitle>
            <DialogDescription>
              This will permanently delete <strong>{workspaceName}</strong> and all its data,
              including OKRs, opportunities, experiments, roadmap items, and feedback.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 py-1">
            <label htmlFor="confirm-name" className="text-sm font-medium">
              Type <span className="font-mono font-semibold">{workspaceName}</span> to confirm
            </label>
            <Input
              id="confirm-name"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={workspaceName}
              disabled={isPending}
              autoComplete="off"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter showCloseButton>
            <Button
              type="button"
              variant="destructive"
              disabled={!confirmed || isPending}
              onClick={handleDelete}
            >
              {isPending ? "Deleting..." : "Delete workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
