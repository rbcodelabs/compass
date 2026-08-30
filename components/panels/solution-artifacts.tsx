"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { linkArtifact, unlinkArtifact } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";

export type SolutionArtifact = { id: string; title: string; sourceType: string };

export function SolutionArtifacts({
  solutionId,
  workspaceId,
  orgSlug,
  workspaceSlug,
  artifacts,
  availableArtifacts,
  revalidatePathStr,
  onChanged,
}: {
  solutionId: string;
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  artifacts: SolutionArtifact[];
  availableArtifacts: SolutionArtifact[];
  revalidatePathStr: string;
  onChanged: () => void;
}) {
  const [artifactId, setArtifactId] = useState("");
  const [isPending, startTransition] = useTransition();
  const unlinked = availableArtifacts.filter(
    (artifact) => !artifacts.some((linked) => linked.id === artifact.id)
  );

  return (
    <div className="flex flex-col gap-2">
      {artifacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No linked artifacts.</p>
      ) : (
        artifacts.map((artifact) => (
          <div key={artifact.id} className="flex items-center justify-between gap-2 text-sm">
            <Link
              className="text-primary hover:underline"
              href={`/${orgSlug}/${workspaceSlug}/docs/artifacts/${artifact.id}`}
            >
              {artifact.title}
            </Link>
            <Button
              size="xs"
              variant="ghost"
              disabled={isPending}
              onClick={() => startTransition(async () => {
                await unlinkArtifact(workspaceId, artifact.id, solutionId, revalidatePathStr);
                onChanged();
              })}
            >
              Unlink
            </Button>
          </div>
        ))
      )}
      {unlinked.length > 0 && (
        <div className="flex items-center gap-2">
          <Select value={artifactId} onValueChange={(value) => setArtifactId(value ?? "")} disabled={isPending}>
            <SelectTrigger size="sm" aria-label="Artifact to link" className="min-w-0 flex-1">
              <SelectValue placeholder="Select artifact…" />
            </SelectTrigger>
            <SelectContent>
              {unlinked.map((artifact) => (
                <SelectItem key={artifact.id} value={artifact.id}>{artifact.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={!artifactId || isPending}
            onClick={() => startTransition(async () => {
              await linkArtifact(workspaceId, artifactId, solutionId, revalidatePathStr);
              setArtifactId("");
              onChanged();
            })}
          >
            Link
          </Button>
        </div>
      )}
    </div>
  );
}
