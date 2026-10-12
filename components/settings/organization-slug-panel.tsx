"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateOrganizationSlug } from "@/app/[orgSlug]/settings/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { validateOrgSlug } from "@/lib/org-slug";

interface Props {
  orgSlug: string;
}

/**
 * Org URL-slug editor. Renaming is two steps on purpose: the field only
 * validates; "Change URL slug" opens a confirmation that spells out what
 * changes, and only its confirm button calls the action. The old slug keeps
 * redirecting (see lib/org-slug.ts), but anything that cannot follow a
 * redirect — an API client, an allow-list, a printed link — does not.
 */
export function OrganizationSlugPanel({ orgSlug }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(orgSlug);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const trimmed = value.trim();
  const unchanged = trimmed === orgSlug;
  // Surfaced only once the user has typed something different, so the field is
  // not red on first paint.
  const validationError = unchanged ? null : validateOrgSlug(trimmed);
  const canSubmit = !unchanged && !validationError && !isPending;

  function handleChange(next: string) {
    // Lowercase as they type; the server re-validates regardless.
    setValue(next.toLowerCase());
    setConfirming(false);
    setError(null);
  }

  function handleConfirm() {
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      const result = await updateOrganizationSlug(orgSlug, trimmed);
      if (!result.ok) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      // This page's own URL still contains the old slug, so navigate to the new one.
      router.push(result.redirectTo);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {/* "Organization URL slug", not "URL slug": the Create workspace form on the same page already owns that label. */}
        <label htmlFor="org-url-slug" className="text-sm font-medium text-text-primary">
          Organization URL slug
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            id="org-url-slug"
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            disabled={isPending}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={validationError ? true : undefined}
            aria-describedby="org-url-slug-help"
            className="font-mono sm:max-w-xs"
          />
          {!confirming && (
            <Button
              type="button"
              variant="outline"
              disabled={!canSubmit}
              onClick={() => setConfirming(true)}
              className="shrink-0"
            >
              Change URL slug
            </Button>
          )}
        </div>
        <p id="org-url-slug-help" className="text-sm text-text-subtle">
          Lowercase letters, numbers, and hyphens. Appears in every link:{" "}
          <span className="font-mono">/{trimmed || "your-org"}/…</span>
        </p>
        {validationError && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {validationError}
          </p>
        )}
      </div>

      {confirming && canSubmit && (
        <div
          role="alertdialog"
          aria-labelledby="org-slug-confirm-title"
          className="flex flex-col gap-3 rounded-xl border border-status-warning/40 bg-status-warning-surface px-4 py-4"
        >
          <span id="org-slug-confirm-title" className="text-sm font-semibold text-text-primary">
            Change the URL slug from <span className="font-mono">{orgSlug}</span> to{" "}
            <span className="font-mono">{trimmed}</span>?
          </span>
          <ul className="ml-4 list-disc space-y-1 text-sm text-text-primary">
            <li>
              Every page URL changes, including shared workspace links and your public
              portal links.
            </li>
            <li>
              Old links keep working: visiting <span className="font-mono">/{orgSlug}/…</span>{" "}
              redirects to the new address. Browsers and the portal follow the redirect.
            </li>
            <li>
              <strong>Anything that cannot follow a redirect</strong> should be updated by hand:
              integrations or scripts that pass the org slug to the API or MCP (they will get
              a &ldquo;not found&rdquo; error naming the new slug), allow-lists, and printed or
              embedded links.
            </li>
            <li>
              The old slug stays reserved for this organization, so no one else can claim it.
            </li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={isPending} onClick={handleConfirm}>
              {isPending ? "Changing…" : "Yes, change URL slug"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
