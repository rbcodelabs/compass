"use client";

/**
 * The Positioning & Messaging Brief row inside the panel's Launch section.
 * When a brief exists it links to the doc editor; otherwise a button creates
 * one from the GTM template and navigates straight to it.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FileText, ExternalLinkIcon, Plus } from "lucide-react";
import { createPositioningBrief } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";

export function PositioningBriefRow({
  itemId,
  workspaceId,
  orgSlug,
  workspaceSlug,
  brief,
}: {
  itemId: string;
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  brief: { id: string; title: string } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const docsBase = `/${orgSlug}/${workspaceSlug}/docs`;

  if (brief) {
    return (
      <Link
        href={`${docsBase}/${brief.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-foreground/80 hover:text-foreground transition-colors w-fit"
      >
        <FileText className="size-3.5 text-muted-foreground" />
        View positioning brief
        <ExternalLinkIcon className="size-3 text-muted-foreground" />
      </Link>
    );
  }

  function create() {
    if (pending) return;
    startTransition(async () => {
      try {
        const { docId } = await createPositioningBrief(itemId, workspaceId, docsBase);
        router.push(`${docsBase}/${docId}`);
      } catch {
        // no-op: stays on the "create" affordance
      }
    });
  }

  return (
    <button
      type="button"
      onClick={create}
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground/80 hover:bg-muted/50 transition-colors w-fit disabled:opacity-60"
    >
      <Plus className="size-3.5" />
      {pending ? "Creating…" : "Create positioning brief"}
    </button>
  );
}
