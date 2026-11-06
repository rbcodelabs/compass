import { Button } from "@/components/ui/button";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
}

/**
 * Downloads a portable bundle of this workspace. A plain link, so the browser streams the zip straight
 * to disk (no client memory use) and the server enforces who may export.
 */
export function ExportWorkspacePanel({ orgSlug, workspaceSlug }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        The bundle holds everything in this workspace — work items, docs, artifacts, research, decisions, comments and their files. Passwords, API keys, SSO and
        Anthropic keys, share links, sessions and agent run history are never included. Import it from Organization Settings to make a copy or move it to another organization.
      </p>
      <div>
        <Button asChild variant="outline">
          <a href={`/api/workspace-export/${encodeURIComponent(orgSlug)}/${encodeURIComponent(workspaceSlug)}`} download data-testid="export-workspace">
            Download workspace bundle
          </a>
        </Button>
      </div>
    </div>
  );
}
