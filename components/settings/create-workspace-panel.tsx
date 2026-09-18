"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createWorkspace } from "@/app/[orgSlug]/settings/actions";
import { deriveSlug } from "@/lib/slug";

export interface OrgWorkspaceSummary {
  id: string;
  name: string;
  slug: string;
}

/**
 * The only browser path for adding a workspace to an existing organization.
 *
 * The MCP `create_workspace` tool is denied to agent identities, and the
 * onboarding wizard is unreachable once the user already has a membership, so
 * before this panel an org admin had no way to create a second workspace
 * without an operator running a tool for them.
 *
 * Expand-in-place rather than a modal, matching AddScoringModelForm on this
 * same page.
 */
export function CreateWorkspacePanel({
  orgSlug,
  workspaces,
}: {
  orgSlug: string;
  workspaces: OrgWorkspaceSummary[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<OrgWorkspaceSummary[]>([]);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  // Once the user edits the slug field themselves, typing in Name must stop
  // overwriting it — otherwise a deliberate slug is silently clobbered by the
  // next keystroke in Name.
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const allWorkspaces = [...workspaces, ...created];

  function reset() {
    setName("");
    setSlug("");
    setSlugEdited(false);
    setDescription("");
    setError(null);
  }

  function handleNameChange(value: string) {
    setName(value);
    if (!slugEdited) setSlug(deriveSlug(value));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isPending) return;

    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    if (!trimmedName || !trimmedSlug) return;

    setError(null);
    startTransition(async () => {
      const result = await createWorkspace(orgSlug, {
        name: trimmedName,
        slug: trimmedSlug,
        description: description.trim() || undefined,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setCreated((current) => [
        ...current,
        {
          id: result.workspace.id,
          name: result.workspace.name,
          slug: result.workspace.slug,
        },
      ]);
      setOpen(false);
      reset();
      router.push(result.redirectTo);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {allWorkspaces.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {allWorkspaces.map((workspace) => (
            <li
              key={workspace.id}
              className="flex items-baseline justify-between gap-3 rounded-lg ring-1 ring-border px-3 py-2"
            >
              <span className="text-sm font-medium">{workspace.name}</span>
              <span className="text-xs text-muted-foreground">
                /{orgSlug}/{workspace.slug}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 w-full rounded-lg border border-dashed border-border/60 py-2 px-3 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
        >
          <PlusIcon className="w-3.5 h-3.5" />
          Create workspace
        </button>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3"
        >
          <p className="text-sm font-medium">New Workspace</p>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-workspace-name">Name</Label>
              <Input
                id="new-workspace-name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. Product Team"
                autoFocus
                required
                disabled={isPending}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-workspace-slug">URL slug</Label>
              <Input
                id="new-workspace-slug"
                value={slug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value);
                }}
                placeholder="product-team"
                pattern="[a-z0-9-]+"
                required
                disabled={isPending}
              />
              <p className="text-xs text-muted-foreground">
                /{orgSlug}/{slug || "your-workspace"}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-workspace-description">Description</Label>
            <Textarea
              id="new-workspace-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this workspace is for (optional)"
              disabled={isPending}
              rows={2}
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? "Creating..." : "Create Workspace"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
