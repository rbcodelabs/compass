"use client";

import { useEffect, useId, useState, type CSSProperties } from "react";
import { renderMermaid, type MermaidResult } from "@/lib/mermaid-render";

/**
 * Pele reads its palette from --pele-* variables. Pointing them at the app's
 * semantic tokens means light/dark follows the active theme through CSS alone —
 * the SVG is not re-rendered when the theme flips.
 */
const THEME: CSSProperties = {
  ["--pele-bg" as string]: "var(--surface-card)",
  ["--pele-fg" as string]: "var(--text-primary)",
  ["--pele-muted" as string]: "var(--text-subtle)",
  ["--pele-line" as string]: "var(--text-secondary)",
  ["--pele-surface" as string]: "var(--surface-inset)",
  ["--pele-surface-alt" as string]: "var(--surface-navigation-active)",
  ["--pele-border" as string]: "var(--border-strong)",
  ["--pele-accent" as string]: "var(--primary)",
  ["--pele-font" as string]: "inherit",
};

/** Shown for invalid syntax: the renderer's message, then the source untouched. */
export function MermaidError({ error, source }: { error: string; source: string }) {
  return (
    <div role="alert" data-testid="mermaid-error" className="rounded-lg border border-destructive/40 bg-surface-inset p-3 text-xs">
      <p className="mb-2 font-medium text-destructive">Diagram could not be rendered</p>
      <pre className="mb-2 whitespace-pre-wrap font-mono text-text-secondary">{error}</pre>
      <pre className="overflow-x-auto font-mono text-text-primary">{source}</pre>
    </div>
  );
}

export function MermaidDiagram({ source }: { source: string }) {
  const idPrefix = `mmd${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [result, setResult] = useState<{ source: string; value: MermaidResult } | null>(null);

  useEffect(() => {
    let cancelled = false;
    renderMermaid(source, idPrefix).then((value) => {
      if (!cancelled) setResult({ source, value });
    });
    return () => {
      cancelled = true;
    };
  }, [source, idPrefix]);

  // While a newer source is rendering keep the previous diagram on screen
  // rather than flashing the placeholder on every keystroke.
  if (!result) {
    return (
      <div className="my-2 text-xs text-text-subtle" data-testid="mermaid-loading">
        Rendering diagram…
      </div>
    );
  }
  if (!result.value.ok) return <MermaidError error={result.value.error} source={source} />;
  return (
    <div
      data-testid="mermaid-diagram"
      className="my-2 overflow-x-auto"
      style={THEME}
      // SVG is sanitized by renderMermaid (lib/mermaid-render.ts).
      dangerouslySetInnerHTML={{ __html: result.value.svg }}
    />
  );
}
