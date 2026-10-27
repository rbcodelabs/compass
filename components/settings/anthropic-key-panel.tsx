"use client";

import { useState, useTransition } from "react";
import { removeWorkspaceAnthropicApiKey, setWorkspaceAnthropicApiKey } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { Button } from "@/components/ui/button";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  /** Last four characters of the stored key, or null when the workspace uses the platform key. The key itself never reaches the client. */
  initialLast4: string | null;
  canEdit: boolean;
}

/** Admin-managed bring-your-own Anthropic key. Write-only: the input is cleared after every save and only the last four characters are ever shown. */
export function AnthropicKeyPanel({ orgSlug, workspaceSlug, initialLast4, canEdit }: Props) {
  const [last4, setLast4] = useState(initialLast4);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const status = last4 ? (
    <p className="text-sm" data-testid="anthropic-key-status">
      Using your own key ending in <code className="font-mono">{last4}</code>.
    </p>
  ) : (
    <p className="text-sm text-muted-foreground" data-testid="anthropic-key-status">Using the Compass platform key.</p>
  );

  if (!canEdit) {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-3.5" data-testid="anthropic-key-readonly">
        {status}
        <p className="mt-1 text-xs text-muted-foreground">Only workspace admins can change this.</p>
      </div>
    );
  }

  function handleSave() {
    setError(null);
    setNotice(null);
    const submitted = value;
    startTransition(async () => {
      try {
        const result = await setWorkspaceAnthropicApiKey(orgSlug, workspaceSlug, { apiKey: submitted });
        if (result.ok) {
          setLast4(result.last4);
          setValue("");
          setNotice("Saved. Agent runs in this workspace now use your key.");
        } else {
          setError(result.error);
        }
      } catch {
        setError("You do not have permission to change this, or the request failed.");
      }
    });
  }

  function handleRemove() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await removeWorkspaceAnthropicApiKey(orgSlug, workspaceSlug);
        setLast4(null);
        setValue("");
        setNotice("Removed. Agent runs use the Compass platform key.");
      } catch {
        setError("You do not have permission to change this, or the request failed.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
      {status}
      <label htmlFor="anthropic-api-key" className="text-sm font-medium">{last4 ? "Replace key" : "Anthropic API key"}</label>
      <input
        id="anthropic-api-key"
        data-testid="anthropic-key-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="h-9 rounded-md border border-border bg-background px-3 font-mono text-xs"
        placeholder="sk-ant-api..."
        value={value}
        disabled={isPending}
        onChange={(event) => setValue(event.target.value)}
      />
      <span className="text-xs text-muted-foreground">
        Stored encrypted and never shown again; only the last four characters are displayed. Agent usage is billed to your Anthropic account.
      </span>
      {notice && <p role="status" data-testid="anthropic-key-notice" className="text-xs text-status-success">{notice}</p>}
      {error && <p role="alert" data-testid="anthropic-key-error" className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending || !value.trim()} data-testid="anthropic-key-save">
          {isPending ? "Saving…" : last4 ? "Replace key" : "Save key"}
        </Button>
        {last4 && (
          <Button size="sm" variant="outline" onClick={handleRemove} disabled={isPending} data-testid="anthropic-key-remove">
            Remove key
          </Button>
        )}
      </div>
    </div>
  );
}
