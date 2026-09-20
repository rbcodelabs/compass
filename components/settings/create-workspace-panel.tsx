"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createWorkspace } from "@/app/[orgSlug]/settings/actions";
import { deriveSlug, SLUG_PATTERN } from "@/lib/slug";

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
  // No optimistic `created` list. The action's revalidatePath re-renders this
  // route's server components while this client component stays mounted, so an
  // appended row would arrive a second time in the `workspaces` prop and
  // render two <li> under the same React key. The unconditional router.push on
  // success means such a row is never meaningfully seen anyway.
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  // Once the user edits the slug field themselves, typing in Name must stop
  // overwriting it — otherwise a deliberate slug is silently clobbered by the
  // next keystroke in Name.
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // A non-empty Name that derives to nothing (e.g. "日本語", "!!!") leaves the
  // slug field blank, and the browser then points a "please fill out this
  // field" tooltip at an input the user never touched. Say why instead.
  const slugUnderivable = name.trim().length > 0 && deriveSlug(name) === "";

  function reset() {
    setName("");
    setSlug("");
    setSlugEdited(false);
    setDescription("");
    setError(null);
  }

  /**
   * Returns the first reason this submission cannot proceed, or null.
   *
   * Whitespace satisfies the `required` attribute, so native validation lets a
   * name of "   " through — and the client then has to say something, because
   * previously it returned silently and the button looked broken.
   */
  function validationError(trimmedName: string, trimmedSlug: string): string | null {
    // Same sentences the server action returns for these inputs, so the user
    // sees one wording whichever layer catches it.
    if (!trimmedName) return "Workspace name is required.";
    if (!trimmedSlug) return "URL slug is required.";
    if (!SLUG_PATTERN.test(trimmedSlug)) {
      return "Slug may only contain lowercase letters, numbers, and hyphens.";
    }
    return null;
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
    const invalid = validationError(trimmedName, trimmedSlug);
    if (invalid) {
      setError(invalid);
      return;
    }

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

      setOpen(false);
      reset();
      router.push(result.redirectTo);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {workspaces.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {workspaces.map((workspace) => (
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
                aria-describedby="new-workspace-slug-hint"
              />
              {slugUnderivable && !slug ? (
                <p id="new-workspace-slug-hint" className="text-xs text-status-warning">
                  A slug can&apos;t be derived from that name — enter one using
                  lowercase letters, numbers, and hyphens.
                </p>
              ) : (
                <p id="new-workspace-slug-hint" className="text-xs text-muted-foreground">
                  /{orgSlug}/{slug || "your-workspace"}
                </p>
              )}
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
