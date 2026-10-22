"use client";

import { useState, useTransition } from "react";
import { updateAgentGithubRepos } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { Button } from "@/components/ui/button";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  initialRepos: string[];
  canEdit: boolean;
}

/**
 * Admin-managed allowlist of GitHub repos agents may push to. One owner per
 * workspace (a single short-lived token covers the whole list), and each repo
 * must already have the GitHub App installed — the server enforces both.
 */
export function AgentGithubReposPanel({ orgSlug, workspaceSlug, initialRepos, canEdit }: Props) {
  const [saved, setSaved] = useState(initialRepos);
  const [text, setText] = useState(initialRepos.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await updateAgentGithubRepos(orgSlug, workspaceSlug, { repos: text.split(/[\n,]+/) });
      if (result.ok) {
        setSaved(result.repos);
        setText(result.repos.join("\n"));
        setNotice(result.repos.length ? `Saved. Agents can use ${result.repos.length} ${result.repos.length === 1 ? "repository" : "repositories"}.` : "Saved. Agents have no GitHub access.");
      } else {
        setError(result.error);
      }
    });
  }

  if (!canEdit) {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-3.5 text-xs text-muted-foreground" data-testid="agent-github-repos-readonly">
        {saved.length ? saved.join(", ") : "No repositories approved. Ask a workspace admin to add some."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
      <label htmlFor="agent-github-repos" className="text-sm font-medium">Approved repositories</label>
      <textarea
        id="agent-github-repos"
        data-testid="agent-github-repos-input"
        className="min-h-24 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
        placeholder={"rbcodelabs/compass\nrbcodelabs/another-repo"}
        value={text}
        disabled={isPending}
        onChange={(event) => setText(event.target.value)}
      />
      <span className="text-xs text-muted-foreground">
        One <code>owner/name</code> per line, up to 10, all under the same GitHub owner. The Compass GitHub App must be installed on each.
        Leave empty to give agents no GitHub access.
      </span>
      {notice && <p role="status" data-testid="agent-github-repos-notice" className="text-xs text-status-success">{notice}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div>
        <Button size="sm" onClick={handleSave} disabled={isPending} data-testid="agent-github-repos-save">
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
