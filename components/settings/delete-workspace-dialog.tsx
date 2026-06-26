"use client";

import { useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteWorkspace } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  workspaceName: string;
}

export function DeleteWorkspaceDialog({ orgSlug, workspaceSlug, workspaceName }: Props) {
  const [open, setOpen] = useState(false);
  const [confirmValue, setConfirmValue] = useState("");
  const [isPending, startTransition] = useTransition();

  const isConfirmed = confirmValue === workspaceName;

  function handleOpenChange(nextOpen: boolean) {
    if (!isPending) {
      setOpen(nextOpen);
      if (!nextOpen) setConfirmValue("");
    }
  }

  function handleDelete() {
    if (!isConfirmed) return;
    startTransition(async () => {
      await deleteWorkspace(orgSlug, workspaceSlug);
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Delete Workspace
      </Button>

      <DialogContent showCloseButton={!isPending}>
        <DialogHeader>
          <DialogTitle>Delete workspace</DialogTitle>
          <DialogDescription>
            This will permanently delete <strong>{workspaceName}</strong> and all its
            data, including opportunities, experiments, OKRs, roadmap items, feedback,
            and docs. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirm-workspace-name">
            Type <strong>{workspaceName}</strong> to confirm
          </Label>
          <Input
            id="confirm-workspace-name"
            value={confirmValue}
            onChange={(e) => setConfirmValue(e.target.value)}
            placeholder={workspaceName}
            disabled={isPending}
            autoComplete="off"
          />
        </div>

        <DialogFooter>
          <DialogClose
            render={<Button variant="outline" disabled={isPending} />}
          >
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            disabled={!isConfirmed || isPending}
            onClick={handleDelete}
          >
            {isPending ? "Deleting..." : "Delete Workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
