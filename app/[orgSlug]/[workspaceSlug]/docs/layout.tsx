import { requireWorkspaceContext } from "@/lib/workspace-context";

interface DocsLayoutProps {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

/**
 * The Docs tree no longer lives here. It is the "Library" view of the agent
 * rail (components/agent/rail-library-pane.tsx), mounted once in the workspace
 * layout; the Docs headers carry a DocsLibraryButton that opens it.
 *
 * What remains is the workspace gate (child pages rely on it) and the scroll
 * container they render into.
 */
export default async function DocsLayout({
  children,
  params,
}: DocsLayoutProps) {
  const { orgSlug, workspaceSlug } = await params;

  // Resolves from the request memo — the parent workspace layout already
  // asked for this exact context, so this costs no additional statements.
  await requireWorkspaceContext(orgSlug, workspaceSlug);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto min-w-0">{children}</div>
    </div>
  );
}
