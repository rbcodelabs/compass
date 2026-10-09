"use client";

import * as React from "react";
import { PanelLeftOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  docsLibraryCookieString,
  type DocsLibraryState,
} from "@/lib/docs-library-pane";

interface DocsLibraryContextValue {
  collapsed: boolean;
  width: number;
  /** Persist and apply a new collapsed flag. Width is kept for the next expand. */
  setCollapsed: (next: boolean) => void;
  /** Persist and apply a new width. Also expands, since a width only means something expanded. */
  setWidth: (next: number) => void;
}

const DocsLibraryContext = React.createContext<DocsLibraryContextValue | null>(null);

/** Attribute the collapse button uses to hand focus to the expand control. */
export const DOCS_LIBRARY_EXPAND_ATTR = "data-docs-library-expand";

/**
 * Owns the Library pane's collapsed/width state so controls in different parts
 * of the Docs layout (the pane itself, and the expand button that sits beside
 * the page title once the pane is gone) stay in sync. The cookie is written
 * here so every caller persists the same way.
 */
export function DocsLibraryProvider({
  initialState,
  children,
}: {
  initialState: DocsLibraryState;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsedState] = React.useState(initialState.collapsed);
  const [width, setWidthState] = React.useState(initialState.width);

  const persist = React.useCallback((next: DocsLibraryState) => {
    document.cookie = docsLibraryCookieString(next);
  }, []);

  const setCollapsed = React.useCallback(
    (next: boolean) => {
      setCollapsedState(next);
      persist({ collapsed: next, width });
      // Collapsing removes the focused button from view; hand focus to the
      // counterpart control rather than dropping it on <body>.
      if (next) {
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>(`[${DOCS_LIBRARY_EXPAND_ATTR}]`)?.focus(),
        );
      }
    },
    [persist, width],
  );

  const setWidth = React.useCallback(
    (next: number) => {
      setWidthState(next);
      setCollapsedState(false);
      persist({ collapsed: false, width: next });
    },
    [persist],
  );

  const value = React.useMemo(
    () => ({ collapsed, width, setCollapsed, setWidth }),
    [collapsed, width, setCollapsed, setWidth],
  );

  return <DocsLibraryContext.Provider value={value}>{children}</DocsLibraryContext.Provider>;
}

export function useDocsLibrary(): DocsLibraryContextValue {
  const ctx = React.useContext(DocsLibraryContext);
  if (!ctx) throw new Error("useDocsLibrary must be used inside <DocsLibraryProvider>");
  return ctx;
}

/**
 * Expand control for the collapsed Library pane. Place it inline beside a page
 * title. Renders nothing while the pane is open, on mobile (which has its own
 * Pages drawer), or outside a Docs layout (editors rendered in isolation).
 */
export function DocsLibraryExpandButton({ className }: { className?: string }) {
  const ctx = React.useContext(DocsLibraryContext);
  if (!ctx?.collapsed) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={() => ctx.setCollapsed(false)}
      aria-label="Expand library"
      aria-expanded={false}
      title="Expand library"
      data-testid="library-expand"
      {...{ [DOCS_LIBRARY_EXPAND_ATTR]: "" }}
      className={cn("hidden md:inline-flex shrink-0 text-text-subtle hover:text-text-primary", className)}
    >
      <PanelLeftOpen className="w-3.5 h-3.5" />
    </Button>
  );
}
