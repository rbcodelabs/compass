"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  orgSlug: string;
}

type Result = {
  slug: string;
  name: string;
  usersMatched: number;
  usersFallbackToImporter: number;
  blobsCopied: number;
  warnings: string[];
};

/**
 * Imports a workspace bundle as a NEW workspace. Files above the serverless request limit are uploaded
 * straight to Blob (the server hands out a signed target); the import itself then runs server-side.
 * One nonce per attempt makes a retry resume the same import instead of creating a second copy.
 */
export function ImportWorkspacePanel({ orgSlug }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const nonceRef = useRef<string>(crypto.randomUUID());
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const base = `/api/workspace-import/${encodeURIComponent(orgSlug)}`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a bundle file first.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setStage("Preparing upload…");
      const prep = await fetch(`${base}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileSize: file.size }),
      });
      const plan = await prep.json();
      if (!prep.ok) throw new Error(plan.error ?? "Could not prepare the upload");

      let response: Response;
      if (plan.mode === "direct") {
        setStage("Uploading bundle…");
        const { put } = await import("@vercel/blob/client");
        await put(plan.pathname, file, { access: "private", token: plan.clientToken, contentType: "application/zip" });
        setStage("Importing workspace… this can take a few minutes");
        response = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ receipt: plan.receipt, name: name || undefined, slug: slug || undefined, nonce: nonceRef.current }),
        });
      } else {
        setStage("Importing workspace… this can take a few minutes");
        const form = new FormData();
        form.set("file", file);
        form.set("nonce", nonceRef.current);
        if (name) form.set("name", name);
        if (slug) form.set("slug", slug);
        response = await fetch(base, { method: "POST", body: form });
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "The import failed");
      setResult(data);
      nonceRef.current = crypto.randomUUID();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import failed");
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="import-workspace-form">
      <p className="text-sm text-muted-foreground">
        Upload a bundle downloaded from a workspace&apos;s settings. It is always imported as a new workspace; nothing existing is changed. People are matched by email; anyone not in this
        organization&apos;s member list is attributed to you.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="import-name">Name (optional)</Label>
          <Input id="import-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to “<original> (imported)”" disabled={busy} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="import-slug">URL slug (optional)</Label>
          <Input id="import-slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="e.g. acme-copy" disabled={busy} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="import-file">Bundle file</Label>
        <Input id="import-file" ref={fileRef} type="file" accept=".zip,application/zip" disabled={busy} />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Importing…" : "Import workspace"}
        </Button>
        {stage && <span className="text-sm text-muted-foreground" role="status">{stage}</span>}
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="rounded-md border p-3 text-sm" role="status" data-testid="import-result">
          <p>
            Imported <strong>{result.name}</strong>.{" "}
            <Link className="underline" href={`/${orgSlug}/${result.slug}`}>
              Open the workspace
            </Link>
          </p>
          <p className="text-muted-foreground">
            {result.usersMatched} people matched by email, {result.usersFallbackToImporter} attributed to you, {result.blobsCopied} files copied.
          </p>
          {result.warnings.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-muted-foreground">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
