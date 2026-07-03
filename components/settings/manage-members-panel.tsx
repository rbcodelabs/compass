"use client";

import { useState, useTransition } from "react";
import { PlusIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addWorkspaceMember,
  removeWorkspaceMember,
  updateWorkspaceMemberRole,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import type { MemberData, WorkspaceRole } from "@/lib/types";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  initialMembers: MemberData[];
  currentUserMembershipId: string | null;
}

function AddMemberForm({
  orgSlug,
  workspaceSlug,
  onAdded,
  onError,
}: {
  orgSlug: string;
  workspaceSlug: string;
  onAdded: (member: MemberData) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("MEMBER");
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    startTransition(async () => {
      try {
        await addWorkspaceMember(orgSlug, workspaceSlug, { email: trimmed, role });
        // Optimistically add to list via callback — server will revalidate too.
        // userId is unknown client-side for a brand-new invite; a random id is
        // fine here since it's never used as a lookup key before revalidation.
        onAdded({
          id: crypto.randomUUID(),
          userId: crypto.randomUUID(),
          email: trimmed,
          name: null,
          role,
        });
        setOpen(false);
        setEmail("");
        setRole("MEMBER");
      } catch (err) {
        onError(err instanceof Error ? err.message : "Failed to add member");
      }
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 w-full rounded-lg border border-dashed border-border/60 py-2 px-3 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add member
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3"
    >
      <p className="text-sm font-medium">Add Member</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="member-email">Email</Label>
        <Input
          id="member-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          autoFocus
          required
          disabled={isPending}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Role</Label>
        <Select
          value={role}
          onValueChange={(v) => setRole(v as WorkspaceRole)}
          disabled={isPending}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="MEMBER">Member</SelectItem>
            <SelectItem value="ADMIN">Admin</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending || !email.trim()}>
          {isPending ? "Adding..." : "Add Member"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ManageMembersPanel({
  orgSlug,
  workspaceSlug,
  initialMembers,
  currentUserMembershipId,
}: Props) {
  const [members, setMembers] = useState(initialMembers);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const adminCount = members.filter((m) => m.role === "ADMIN").length;

  function handleRoleChange(memberId: string, role: WorkspaceRole) {
    setError(null);
    const previous = members;
    setMembers((cur) => cur.map((m) => (m.id === memberId ? { ...m, role } : m)));

    startTransition(async () => {
      try {
        await updateWorkspaceMemberRole(orgSlug, workspaceSlug, memberId, role);
      } catch (err) {
        setMembers(previous); // revert optimistic update — server rejected it
        setError(err instanceof Error ? err.message : "Failed to update role");
      }
    });
  }

  function handleRemove(memberId: string) {
    setError(null);
    const previous = members;
    setMembers((cur) => cur.filter((m) => m.id !== memberId));

    startTransition(async () => {
      try {
        await removeWorkspaceMember(orgSlug, workspaceSlug, memberId);
      } catch (err) {
        setMembers(previous); // revert optimistic update — server rejected it
        setError(err instanceof Error ? err.message : "Failed to remove member");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-sm text-red-600">{error}</p>}

      {members.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden">
          {members.map((member, i) => {
            // Mirror the server-side last-admin guard so the control is
            // disabled before the request round-trip; the server action is
            // still the source of truth if this list is stale.
            const isLastAdmin = member.role === "ADMIN" && adminCount <= 1;
            const isOnlyMember = members.length <= 1;

            return (
              <div
                key={member.id}
                className={`flex items-center justify-between gap-3 px-4 py-2.5 ${
                  i > 0 ? "border-t border-border" : ""
                }`}
              >
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium truncate">
                    {member.name || member.email}
                    {member.id === currentUserMembershipId && (
                      <span className="text-muted-foreground font-normal"> (you)</span>
                    )}
                  </span>
                  {member.name && (
                    <span className="text-xs text-muted-foreground truncate">
                      {member.email}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Select
                    value={member.role}
                    onValueChange={(v) => handleRoleChange(member.id, v as WorkspaceRole)}
                    disabled={isPending || isLastAdmin}
                  >
                    <SelectTrigger size="sm" className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MEMBER">Member</SelectItem>
                      <SelectItem value="ADMIN">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  <button
                    onClick={() => handleRemove(member.id)}
                    disabled={isPending || isLastAdmin || isOnlyMember}
                    className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label={`Remove ${member.name || member.email}`}
                  >
                    <TrashIcon className="size-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {members.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No members yet. Add teammates by email to give them access to this workspace.
        </p>
      )}

      <AddMemberForm
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        onAdded={(member) => setMembers((prev) => [...prev, member])}
        onError={(message) => setError(message)}
      />
    </div>
  );
}
