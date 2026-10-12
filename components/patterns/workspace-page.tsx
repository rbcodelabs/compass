import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One size for every control in the header, so a mixed cluster (segmented view
 * switcher, filter, primary action, ⋯) reads as a single row: 44px below `md`
 * for touch, 32px from `md`. Applied here rather than per control so a control
 * that is also used outside the header (FacetedFilterMenu, Tabs) keeps its own size there. Matches `button` rather than
 * `data-slot=button` because menu triggers overwrite the slot; tab triggers are excluded.
 */
const HEADER_CONTROL_SIZE =
  "[&_button:not([role=tab])]:h-11 [&_button:not([role=tab])]:min-w-11 [&_button:not([role=tab])]:rounded-lg md:[&_button:not([role=tab])]:h-8 md:[&_button:not([role=tab])]:min-w-8 " +
  "[&_[data-slot=tabs-list]]:!h-11 md:[&_[data-slot=tabs-list]]:!h-8";

type WorkspacePageProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Secondary cluster placed after `actions`: its own full-width row below the title under `md`, inline at the right from `md` up. */
  controls?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
};

type WorkspaceHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  controls?: ReactNode;
  className?: string;
};

/**
 * The sticky header frame shared by every workspace page. `WorkspacePage` renders
 * it; pages whose header must live inside a client component (Roadmap keeps
 * timeline state) render it directly. See docs/design/workspace-header.md.
 */
export function WorkspaceHeader({ title, description, actions, controls, className }: WorkspaceHeaderProps) {
  return (
    <header
      data-slot="workspace-header"
      className={cn(
        "sticky top-0 z-20 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-default bg-surface-app/95 px-4 py-3 backdrop-blur sm:px-5 md:static md:flex-nowrap md:px-6",
        className
      )}
    >
      {/* Below md the header wraps: the min width keeps the title readable, so a wide
          actions cluster drops to its own row instead of squeezing the title to "T…". */}
      <div className="min-w-[8rem] flex-1 md:min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight text-text-primary">{title}</h1>
        {description && (
          <div className="mt-0.5 hidden truncate text-xs text-text-secondary sm:block">
            {description}
          </div>
        )}
      </div>
      {controls && (
        <div
          data-slot="workspace-header-controls"
          className={cn("order-last flex min-w-0 basis-full items-center gap-2 md:basis-auto", HEADER_CONTROL_SIZE)}
        >
          {controls}
        </div>
      )}
      {actions && (
        <div data-slot="workspace-header-actions" className={cn("ml-auto flex shrink-0 items-center gap-2", HEADER_CONTROL_SIZE)}>
          {actions}
        </div>
      )}
    </header>
  );
}

/** Full-height composition for board, timeline, and other workspace-style pages. */
export function WorkspacePage({
  title,
  description,
  actions,
  controls,
  toolbar,
  children,
  className,
  contentClassName,
}: WorkspacePageProps) {
  return (
    <div className={cn("flex min-h-full flex-1 flex-col md:h-full md:min-h-0", className)}>
      <WorkspaceHeader title={title} description={description} actions={actions} controls={controls} />

      {toolbar && (
        <div
          data-slot="workspace-toolbar"
          // A toolbar whose only content is an empty `[data-toolbar-host]` (a client
          // control portaled in later) must not paint an empty bar.
          className="shrink-0 border-b border-border-default bg-surface-panel px-4 py-2 has-[[data-toolbar-host]:empty]:hidden sm:px-5 md:px-6"
        >
          {toolbar}
        </div>
      )}

      <div
        data-slot="workspace-content"
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto p-3 sm:p-4 md:overflow-hidden md:px-4 md:py-3",
          contentClassName
        )}
      >
        {children}
      </div>
    </div>
  );
}
