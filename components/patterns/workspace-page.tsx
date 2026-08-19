import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type WorkspacePageProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
};

/** Full-height composition for board, timeline, and other workspace-style pages. */
export function WorkspacePage({
  title,
  description,
  actions,
  toolbar,
  children,
  className,
  contentClassName,
}: WorkspacePageProps) {
  return (
    <div className={cn("flex min-h-full flex-1 flex-col md:h-full md:min-h-0", className)}>
      <header
        data-slot="workspace-header"
        className="sticky top-0 z-20 flex shrink-0 items-center justify-between gap-3 border-b border-border-default bg-surface-app/95 px-4 py-3 backdrop-blur sm:px-5 md:static md:px-6"
      >
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight text-text-primary">{title}</h1>
          {description && (
            <div className="mt-0.5 hidden truncate text-xs text-text-secondary sm:block">
              {description}
            </div>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>

      {toolbar && (
        <div
          data-slot="workspace-toolbar"
          className="shrink-0 border-b border-border-default bg-surface-panel px-4 py-2 sm:px-5 md:px-6"
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
