"use client";

import { useState, useTransition } from "react";
import {
  updatePortalSettings,
  regenerateSsoSecret,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { ExternalLink } from "lucide-react";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  feedbackEnabled: boolean;
  roadmapPublic: boolean;
  portalAuthRequired: boolean;
  ssoEnabled: boolean;
  ssoSecretConfigured: boolean;
  ssoSecretUpdatedAt: Date | null;
}

export function PortalSettingsPanel({
  orgSlug,
  workspaceSlug,
  feedbackEnabled: initialFeedback,
  roadmapPublic: initialRoadmap,
  portalAuthRequired: initialPortalAuthRequired,
  ssoEnabled: initialSsoEnabled,
  ssoSecretConfigured: initialSsoSecretConfigured,
  ssoSecretUpdatedAt: initialSsoSecretUpdatedAt,
}: Props) {
  const [feedbackEnabled, setFeedbackEnabled] = useState(initialFeedback);
  const [roadmapPublic, setRoadmapPublic] = useState(initialRoadmap);
  const [portalAuthRequired, setPortalAuthRequired] = useState(initialPortalAuthRequired);
  const [ssoEnabled, setSsoEnabled] = useState(initialSsoEnabled);
  const [isPending, startTransition] = useTransition();

  const [ssoSecretConfigured, setSsoSecretConfigured] = useState(initialSsoSecretConfigured);
  const [ssoSecretUpdatedAt, setSsoSecretUpdatedAt] = useState(initialSsoSecretUpdatedAt);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const roadmapUrl = `/portal/${orgSlug}/${workspaceSlug}/roadmap`;
  const feedbackUrl = `/portal/${orgSlug}/${workspaceSlug}/feedback`;
  // Keep the first server and client render identical. The relative endpoint
  // is also portable across local, preview, and production hosts.
  const ssoExchangeUrl = `/api/portal/${orgSlug}/${workspaceSlug}/sso?token=<jwt>&returnTo=/portal/${orgSlug}/${workspaceSlug}/roadmap`;

  function handleToggle(
    field: "feedbackEnabled" | "roadmapPublic" | "portalAuthRequired" | "ssoEnabled",
    value: boolean
  ) {
    if (field === "feedbackEnabled") setFeedbackEnabled(value);
    else if (field === "roadmapPublic") setRoadmapPublic(value);
    else if (field === "portalAuthRequired") setPortalAuthRequired(value);
    else setSsoEnabled(value);

    startTransition(async () => {
      await updatePortalSettings(orgSlug, workspaceSlug, {
        ...(field === "feedbackEnabled" ? { feedbackEnabled: value } : {}),
        ...(field === "roadmapPublic" ? { roadmapPublic: value } : {}),
        ...(field === "portalAuthRequired" ? { portalAuthRequired: value } : {}),
        ...(field === "ssoEnabled" ? { ssoEnabled: value } : {}),
      });
    });
  }

  function handleGenerateSsoSecret() {
    setSsoError(null);
    setIsGenerating(true);
    startTransition(async () => {
      try {
        const { rawSecret } = await regenerateSsoSecret(orgSlug, workspaceSlug);
        setRevealedSecret(rawSecret);
        setSsoSecretConfigured(true);
        setSsoSecretUpdatedAt(new Date());
      } catch (e) {
        setSsoError(e instanceof Error ? e.message : "Failed to generate SSO secret");
      } finally {
        setIsGenerating(false);
      }
    });
  }

  const portalIsPublic = feedbackEnabled || roadmapPublic;

  return (
    <div className="flex flex-col gap-5">
      {/* Roadmap toggle */}
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Public roadmap</span>
          <span className="text-xs text-muted-foreground">
            Anyone with the link can view the roadmap and vote on items.
          </span>
          {roadmapPublic && (
            <a
              href={roadmapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-1 text-xs text-indigo-600 hover:underline"
            >
              {roadmapUrl}
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        <button
          type="button"
          role="switch"
          data-testid="portal-toggle-roadmap"
          aria-checked={roadmapPublic}
          disabled={isPending}
          onClick={() => handleToggle("roadmapPublic", !roadmapPublic)}
          className={[
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            roadmapPublic ? "bg-indigo-600" : "bg-slate-200",
          ].join(" ")}
        >
          <span
            className={[
              "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-md ring-0 transition-transform",
              roadmapPublic ? "translate-x-4" : "translate-x-0",
            ].join(" ")}
          />
        </button>
      </div>

      {/* Feedback toggle */}
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Public feedback portal</span>
          <span className="text-xs text-muted-foreground">
            Anyone with the link can submit feedback and vote on existing items.
          </span>
          {feedbackEnabled && (
            <a
              href={feedbackUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-1 text-xs text-indigo-600 hover:underline"
            >
              {feedbackUrl}
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        <button
          type="button"
          role="switch"
          data-testid="portal-toggle-feedback"
          aria-checked={feedbackEnabled}
          disabled={isPending}
          onClick={() => handleToggle("feedbackEnabled", !feedbackEnabled)}
          className={[
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            feedbackEnabled ? "bg-indigo-600" : "bg-slate-200",
          ].join(" ")}
        >
          <span
            className={[
              "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-md ring-0 transition-transform",
              feedbackEnabled ? "translate-x-4" : "translate-x-0",
            ].join(" ")}
          />
        </button>
      </div>

      {/* Require portal account toggle — only meaningful once the portal is public */}
      {portalIsPublic && (
        <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Require an account to submit/vote</span>
            <span className="text-xs text-muted-foreground">
              Visitors must verify their email with a magic link before submitting feedback or voting.
            </span>
          </div>
          <button
            type="button"
            role="switch"
            data-testid="portal-toggle-auth-required"
            aria-label="Require portal sign-in"
            aria-checked={portalAuthRequired}
            disabled={isPending}
            onClick={() => handleToggle("portalAuthRequired", !portalAuthRequired)}
            className={[
              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              portalAuthRequired ? "bg-indigo-600" : "bg-slate-200",
            ].join(" ")}
          >
            <span
              className={[
                "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-md ring-0 transition-transform",
                portalAuthRequired ? "translate-x-4" : "translate-x-0",
              ].join(" ")}
            />
          </button>
        </div>
      )}

      {/* SSO Identify — a second, instant front door for establishing the same
          portal session as the magic-link flow above. Orthogonal to "require
          an account": SSO can be on with that toggle off (anonymous voting
          still allowed, but SSO visitors get a verified identity), on with it
          on (SSO first, magic-link as fallback), or off entirely. */}
      {portalIsPublic && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">SSO Identify</span>
              <span className="text-xs text-muted-foreground">
                Let visitors arrive pre-verified from your own app via a signed link from
                your backend, instead of (or alongside) the email sign-in above.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              data-testid="portal-toggle-sso"
              aria-checked={ssoEnabled}
              disabled={isPending}
              onClick={() => handleToggle("ssoEnabled", !ssoEnabled)}
              className={[
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                ssoEnabled ? "bg-indigo-600" : "bg-slate-200",
              ].join(" ")}
            >
              <span
                className={[
                  "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-md ring-0 transition-transform",
                  ssoEnabled ? "translate-x-4" : "translate-x-0",
                ].join(" ")}
              />
            </button>
          </div>

          {ssoEnabled && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-slate-50 p-3">
              {/* One-time secret reveal */}
              {revealedSecret ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 flex flex-col gap-1.5">
                  <p className="text-xs font-semibold text-emerald-800">
                    Copy this secret now — it will never be shown again.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-white border border-emerald-200 rounded px-2 py-1 font-mono break-all">
                      {revealedSecret}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(revealedSecret);
                      }}
                      className="shrink-0 text-xs text-emerald-700 hover:text-emerald-900 font-medium"
                    >
                      Copy
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRevealedSecret(null)}
                    className="self-end text-xs text-emerald-600 hover:text-emerald-800"
                  >
                    I&apos;ve saved it ✓
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    {ssoSecretConfigured
                      ? `SSO secret configured${
                          ssoSecretUpdatedAt
                            ? `, last rotated ${ssoSecretUpdatedAt.toLocaleDateString()}`
                            : ""
                        }.`
                      : "No SSO secret configured yet — generate one to get started."}
                  </span>
                  <button
                    type="button"
                    onClick={handleGenerateSsoSecret}
                    disabled={isPending || isGenerating}
                    className="shrink-0 h-8 px-3 rounded-md bg-slate-900 text-white text-xs font-medium hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {ssoSecretConfigured ? "Rotate secret" : "Generate secret"}
                  </button>
                </div>
              )}

              {ssoError && <p className="text-xs text-red-600">{ssoError}</p>}

              {/* Integration reference for the customer's developer */}
              <div className="flex flex-col gap-1 border-t border-border pt-2 text-xs text-muted-foreground">
                <p className="font-medium text-slate-700">Integration</p>
                <p>
                  Your backend signs a short-lived (≤5 minute) HS256 JWT using the secret
                  above with the payload{" "}
                  <code className="bg-white border border-border rounded px-1 py-0.5">
                    {"{ email, name?, iat, exp }"}
                  </code>
                  , then sends your signed-in user to:
                </p>
                <code className="block bg-white border border-border rounded px-2 py-1 break-all">
                  {ssoExchangeUrl}
                </code>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
