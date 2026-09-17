import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AppShell({ navigation, mobileHeader, children, className }: { navigation: ReactNode; mobileHeader?: ReactNode; children: ReactNode; className?: string }) {
  return <div className={cn("min-h-screen bg-surface-app text-text-primary", className)}>{mobileHeader}<div className="flex min-h-screen"><aside className="hidden w-60 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:block">{navigation}</aside><main id="main-content" className="min-w-0 flex-1 px-[var(--space-page-x)] py-[var(--space-page-y)]">{children}</main></div></div>;
}
