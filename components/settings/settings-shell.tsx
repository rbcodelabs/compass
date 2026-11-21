import type { ReactNode } from "react";
import { buildSettingsNav, type SettingsNavContext } from "@/lib/settings-nav";
import { SettingsNav } from "@/components/settings/settings-nav";

/**
 * Shared frame for every settings screen. Pages keep their own main element;
 * the shell only adds the scope-grouped nav beside them.
 */
export function SettingsShell({ context, backHref, children }: { context: SettingsNavContext; backHref: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full min-w-0 flex-col md:flex-row">
      <SettingsNav groups={buildSettingsNav(context)} backHref={backHref} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
