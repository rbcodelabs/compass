"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
 * breaks, and only its confirm button calls the action. The old slug is NOT
 * kept, so every link containing it stops working immediately.
 */
export function OrganizationSlugPanel({ orgSlug }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(orgSlug);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const confirmRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const trimmed = value.trim();
  const unchanged = trimmed === orgSlug;
  // Surfaced only once the user has typed something different, so the field is
  // not red on first paint.
  const validationError = unchanged ? null : validateOrgSlug(trimmed);
  const canSubmit = !unchanged && !validationError && !isPending;

  // The confirm step and any server error open below the field. On a phone they can land
  // under the fixed bottom nav (or off-screen), so a tap would hit a nav link instead of
  // the button. Centre them whenever they appear; scroll-mb-16 on each matches the pb-16
  // the settings layout reserves for that nav.
  useEffect(() => {
    if (confirming) confirmRef.current?.scrollIntoView({ block: "center" });
  }, [confirming]);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "center" });
  }, [error]);

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

      {/* Stays mounted while the action is pending (canSubmit goes false then), so the card does not collapse. */}
      {confirming && !unchanged && !validationError && (
        <div
          ref={confirmRef}
          role="alertdialog"
          aria-labelledby="org-slug-confirm-title"
          className="flex scroll-mb-16 flex-col gap-3 rounded-xl border border-status-warning/40 bg-status-warning-surface px-4 py-4"
        >
          <span id="org-slug-confirm-title" className="text-sm font-semibold text-text-primary">
            Change the URL slug from <span className="font-mono">{orgSlug}</span> to{" "}
            <span className="font-mono">{trimmed}</span>?
          </span>
          <ul className="ml-4 list-disc space-y-1 text-sm text-text-primary">
            <li>
              <strong>Old links stop working immediately</strong> and show a &ldquo;not found&rdquo;
              page. There is no redirect from <span className="font-mono">/{orgSlug}/…</span>.
            </li>
            <li>
              That includes bookmarks, links in emails and notifications that were already sent,
              shared workspace links, and your public portal and portal-SSO links.
            </li>
            <li>
              MCP and API clients that pass the old slug as <span className="font-mono">orgSlug</span>{" "}
              will get &ldquo;not found&rdquo; until you update them.
            </li>
            <li>The old slug becomes available for any other organization to claim.</li>
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
        <p ref={errorRef} role="alert" className="scroll-mb-16 text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
