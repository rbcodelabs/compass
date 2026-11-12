"use client";

import { useState, useTransition } from "react";
import { FileText, ImageOff, Link2, Lock, Plus, Presentation, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GalleryArtifact } from "@/lib/gallery/artifacts";

/** The screenshot-capture server action a gallery injects (it differs per surface). */
export type CaptureArtifactPreview = (artifactId: string) => Promise<{ ok: true } | { ok: false; error: string }>;

export function artifactTypeLabel(artifact: GalleryArtifact): { label: string; icon: React.ReactNode } {
  if (artifact.kind === "SLIDE_DECK") return { label: "Slide deck", icon: <Presentation aria-hidden="true" className="size-3" /> };
  if (artifact.sourceType === "EXTERNAL_LINK") return { label: "Link", icon: <Link2 aria-hidden="true" className="size-3" /> };
  if (artifact.sourceType === "V0_CHAT") return { label: "v0 chat", icon: <Sparkles aria-hidden="true" className="size-3" /> };
  return { label: "HTML", icon: <FileText aria-hidden="true" className="size-3" /> };
}

/**
 * The hero of a gallery card: the screenshot of one of the card's artifacts, a filmstrip to swap between
 * them (hover/focus/click), a "+N" for the rest, and a placeholder when nothing is linked or nothing has
 * been captured yet. Shared by the Roadmap and Experiments Galleries; what differs per surface (empty-state
 * copy, the capture action, where "Open artifact" goes) is passed in.
 */
export function ArtifactHero({ artifacts, moreArtifacts, isPrivate, emptyTitle, emptyHint, artifactHref, onCapture }: {
  artifacts: GalleryArtifact[];
  /** Artifacts linked beyond those in `artifacts` (the loader caps the list). */
  moreArtifacts: number;
  isPrivate: boolean;
  /** Placeholder copy when there is no artifact at all. */
  emptyTitle: string;
  emptyHint: string;
  /** Where "Open artifact" goes, for artifacts that cannot be screenshotted. */
  artifactHref: (artifactId: string) => string;
  onCapture: CaptureArtifactPreview;
}) {
  // Open on the first artifact that has a screenshot (newest-first order); only fall back to a placeholder when none do.
  const [active, setActive] = useState(() => Math.max(0, artifacts.findIndex((artifact) => artifact.thumbnail)));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const current = artifacts[Math.min(active, Math.max(artifacts.length - 1, 0))];
  const withShot = artifacts.filter((artifact) => artifact.thumbnail);

  const frame = "relative aspect-[16/10] overflow-hidden rounded-t-xl border-b border-border-default bg-surface-inset";

  if (!current) {
    return (
      <div className={frame} data-testid="gallery-hero-empty">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-text-subtle [background:repeating-linear-gradient(135deg,transparent_0_10px,var(--color-surface-panel)_10px_20px)]">
          <Plus aria-hidden="true" className="size-5" />
          <p className="max-w-[26ch] text-xs">{emptyTitle}</p>
          <p className="text-xs">{emptyHint}</p>
        </div>
      </div>
    );
  }

  const type = artifactTypeLabel(current);
  return (
    <div className={frame}>
      {current.thumbnail ? (
        // A plain <img>, not next/image: the source is an authenticated, no-store route the image optimizer would fetch without the reader's session.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={current.thumbnail.src} width={current.thumbnail.width} height={current.thumbnail.height} alt={`Preview of ${current.title}`} loading="lazy" className="absolute inset-0 size-full object-cover object-top" />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-panel p-4 text-center text-text-subtle" data-testid="gallery-hero-pending">
          <ImageOff aria-hidden="true" className="size-5" />
          <p className="max-w-[28ch] text-xs">
            {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"} linked, no preview captured yet
          </p>
          {current.capturable ? (
            <button
              type="button"
              disabled={pending}
              onClick={(event) => {
                event.stopPropagation();
                setError(null);
                startTransition(async () => {
                  const result = await onCapture(current.id);
                  if (!result.ok) setError(result.error);
                });
              }}
              className="relative z-20 rounded-md border border-border-default bg-surface-card px-3 py-1.5 text-xs font-medium text-text-primary hover:border-primary hover:text-primary disabled:opacity-60"
            >
              {pending ? "Capturing…" : "Capture preview"}
            </button>
          ) : (
            <a href={artifactHref(current.id)} className="relative z-20 text-xs font-medium underline">Open artifact</a>
          )}
          {error && <p role="alert" className="max-w-[32ch] text-xs text-status-danger">{error}</p>}
        </div>
      )}

      <span className="absolute left-2.5 top-2.5 z-10 inline-flex items-center gap-1 rounded-md bg-surface-card/90 px-2 py-0.5 text-[11px] font-semibold text-text-primary shadow-sm">
        {type.icon}
        {type.label}
      </span>
      {isPrivate && (
        <span className="absolute right-2.5 top-2.5 z-10 inline-flex items-center gap-1 rounded-md bg-black/75 px-2 py-0.5 text-[11px] font-medium text-white">
          <Lock aria-hidden="true" className="size-3" /> Private
        </span>
      )}

      {artifacts.length > 1 && (
        <div role="group" aria-label="Artifacts" className="absolute bottom-2.5 left-2.5 z-20 flex items-center gap-1.5">
          {artifacts.slice(0, 3).map((artifact, index) => (
            <button
              key={artifact.id}
              type="button"
              aria-label={`Show ${artifact.title}`}
              aria-pressed={index === active}
              onClick={(event) => { event.stopPropagation(); setActive(index); }}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              className={cn(
                "relative h-8 w-12 overflow-hidden rounded-md border-2 bg-surface-panel shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-black/70",
                index === active ? "border-primary" : "border-white/80 opacity-85",
              )}
            >
              {artifact.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={artifact.thumbnail.src} alt="" loading="lazy" className="size-full object-cover object-top" />
              ) : (
                <ImageOff aria-hidden="true" className="mx-auto size-3 text-text-subtle" />
              )}
            </button>
          ))}
          {artifacts.length + moreArtifacts > 3 && (
            <span className="rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white">+{artifacts.length + moreArtifacts - 3}</span>
          )}
        </div>
      )}
      {withShot.length === 0 && artifacts.length > 1 && <span className="sr-only">None of the linked artifacts has a captured preview yet.</span>}
    </div>
  );
}
