"use client";

import { useState, useTransition } from "react";
import { updateAgentGithubRepos } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { Button } from "@/components/ui/button";
import type { AgentGithubConfig } from "@/lib/agent-github-repos";
import type { AgentGithubAccess } from "@/lib/agent-github-access-level";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  initialConfig: AgentGithubConfig;
  canEdit: boolean;
}

/**
 * Admin-managed allowlist of GitHub repos agents may push to. One owner per
 * workspace (a single short-lived token covers the whole list), and each repo
 * must already have the GitHub App installed — the server enforces both.
 */
export function AgentGithubReposPanel({ orgSlug, workspaceSlug, initialConfig, canEdit }: Props) {
  const [saved, setSaved] = useState(initialConfig);
  const [text, setText] = useState(initialConfig.repos.join("\n"));
  const [access, setAccess] = useState<AgentGithubAccess>(initialConfig.access);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await updateAgentGithubRepos(orgSlug, workspaceSlug, { repos: text.split(/[\n,]+/), access });
      if (result.ok) {
        setSaved({ repos: result.repos, access: result.access });
        setAccess(result.access);
        setText(result.repos.join("\n"));
        setNotice(result.repos.length ? `Saved. Agents have ${result.access === "code-read" ? "read-only (code only) access to" : result.access === "read" ? "read-only access to" : "read and write access to"} ${result.repos.length} ${result.repos.length === 1 ? "repository" : "repositories"}.` : "Saved. Agents have no GitHub access.");
      } else {
        setError(result.error);
      }
    });
  }

  if (!canEdit) {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-3.5 text-xs text-muted-foreground" data-testid="agent-github-repos-readonly">
        {saved.repos.length ? `${saved.repos.join(", ")} (${saved.access === "code-read" ? "read-only, code only" : saved.access === "read" ? "read-only" : "read and write"})` : "No repositories approved. Ask a workspace admin to add some."}
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
      <fieldset className="flex flex-col gap-1.5" disabled={isPending}>
        <legend className="mb-1 text-sm font-medium">Access level</legend>
        <label className="flex items-start gap-2 text-xs">
          <input type="radio" name="agent-github-access" value="code-read" data-testid="agent-github-access-code-read" checked={access === "code-read"} onChange={() => setAccess("code-read")} className="mt-0.5" />
          <span><span className="font-medium">Read-only, code only</span> <span className="text-muted-foreground">— clone and read code. No pull requests or issues. Needs only Contents read on the App.</span></span>
        </label>
        <label className="flex items-start gap-2 text-xs">
          <input type="radio" name="agent-github-access" value="read" data-testid="agent-github-access-read" checked={access === "read"} onChange={() => setAccess("read")} className="mt-0.5" />
          <span><span className="font-medium">Read-only, with pull requests</span> <span className="text-muted-foreground">— clone and inspect code and pull requests. Cannot push or open pull requests.</span></span>
        </label>
        <label className="flex items-start gap-2 text-xs">
          <input type="radio" name="agent-github-access" value="write" data-testid="agent-github-access-write" checked={access === "write"} onChange={() => setAccess("write")} className="mt-0.5" />
          <span><span className="font-medium">Read and write</span> <span className="text-muted-foreground">— also push feature branches and open pull requests. The App must be granted Contents and Pull requests write.</span></span>
        </label>
      </fieldset>
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
