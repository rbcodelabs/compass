"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { PanelRightClose, Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  PanelResizeHandle,
  PANEL_WIDTH_PROPERTY,
} from "@/components/panels/panel-resize-handle";
import { usePanelPin } from "@/hooks/use-panel-pin";
import {
  PANEL_MIN_MAIN,
  PANEL_WIDTH_MIN,
  PANEL_WIDTH_MAX,
  type PanelPin,
} from "@/lib/panel-pin";

interface DocPanelShellProps {
  panelId: "docsComments" | "docsHistory";
  title: string;
  icon?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPin?: PanelPin;
  children: ReactNode | ((pinned: boolean) => ReactNode);
}

/** Docs share pin state with detail panels, but measure their own nested row. */
export function DocPanelShell({
  panelId,
  title,
  icon,
  open,
  onOpenChange,
  initialPin,
  children,
}: DocPanelShellProps) {
  const pin = usePanelPin(panelId, initialPin);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const row = anchorRef.current?.parentElement;
    if (!row) return;
    const measure = () => setRowWidth(row.getBoundingClientRect().width);
    measure();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measure);
    observer?.observe(row);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const roomAllowsPin = rowWidth >= PANEL_MIN_MAIN + PANEL_WIDTH_MIN;
  const isPinnedMode = pin.isPinnedMode && roomAllowsPin;
  // The nested Docs tree has already consumed width from this row. Clamp the
  // initial preference too, rather than waiting until the first resize gesture.
  const effectiveWidth = Math.min(
    pin.width,
    Math.max(PANEL_WIDTH_MIN, rowWidth - PANEL_MIN_MAIN),
  );
  const resolveMaxWidth = useCallback(() => {
    const column = anchorRef.current?.parentElement?.querySelector(
      '[data-slot="doc-editor-column"]',
    );
    if (!(column instanceof HTMLElement)) return PANEL_WIDTH_MAX;
    const actualPanelWidth = asideRef.current?.getBoundingClientRect().width
      ?? effectiveWidth;
    return Math.max(
      PANEL_WIDTH_MIN,
      Math.min(PANEL_WIDTH_MAX,
        actualPanelWidth + column.getBoundingClientRect().width - PANEL_MIN_MAIN),
    );
  }, [effectiveWidth]);
  const toggle = (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={pin.togglePinned}
      data-slot="panel-pin-toggle"
      aria-label={pin.pinned ? "Unpin panel" : "Pin panel"}
      title={pin.pinned ? "Unpin panel" : "Pin panel"}
      aria-pressed={pin.pinned}
    >
      {pin.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
    </Button>
  );
  const body = typeof children === "function" ? children(isPinnedMode) : children;
  // No hydration/idle gate is needed: DocEditor's activeDocPanel starts null,
  // so neither Docs surface opens before the user interacts with the editor.
  return <>
    <span ref={anchorRef} hidden />
    {isPinnedMode ? open && (
      <aside
        ref={asideRef}
        aria-label={title}
        data-slot="pinned-panel"
        data-panel-id={panelId}
        className="relative hidden lg:flex shrink-0 min-h-0 min-w-0 flex-col overflow-hidden border-l border-border-default bg-surface-panel print:hidden"
        style={{
          [PANEL_WIDTH_PROPERTY]: `${effectiveWidth}px`,
          width: "var(--panel-w)",
          maxWidth: `calc(100% - ${PANEL_MIN_MAIN}px)`,
        } as CSSProperties}
        onKeyDown={(event) => {
          if (event.key === "Escape") onOpenChange(false);
        }}
      >
        <PanelResizeHandle
          width={effectiveWidth}
          surfaceRef={asideRef}
          resolveMaxWidth={resolveMaxWidth}
          onCommit={pin.commitWidth}
        />
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-default px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
            {icon}{title}
          </h2>
          <div className="flex items-center gap-1">
            {toggle}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onOpenChange(false)}
              aria-label="Close panel"
              title="Close panel"
            >
              <PanelRightClose aria-hidden />
            </Button>
          </div>
        </div>
        {body}
      </aside>
    ) : (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
          <SheetHeader className="px-4 pt-4 pb-2 border-b border-border-default shrink-0">
            <div className="flex items-center justify-between gap-2 pr-8">
              <SheetTitle className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
                {icon}{title}
              </SheetTitle>
              {pin.viewportAllowsPin && roomAllowsPin && (
                <div className="hidden lg:flex">{toggle}</div>
              )}
            </div>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    )}
  </>;
}
