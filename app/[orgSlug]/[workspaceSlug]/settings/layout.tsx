import type { ReactNode } from "react";
import { SettingsShell } from "@/components/settings/settings-shell";
import { requireWorkspaceContext } from "@/lib/workspace-context";

/**
 * Frames every workspace settings route (the settings page and Modules) in the
 * shared settings shell. Resolves the same cached workspace context the pages
 * use, so it adds no extra query.
 */
export default async function WorkspaceSettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const { workspace, isOrgAdmin } = await requireWorkspaceContext(orgSlug, workspaceSlug);

  return (
    <SettingsShell
      backHref={"/" + orgSlug + "/" + workspaceSlug}
      context={{ orgSlug, workspaceSlug, workspaceName: workspace.name, isOrgAdmin }}
    >
      {children}
    </SettingsShell>
  );
}
