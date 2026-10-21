"use client";
/**
 * The read-only card for one embedded Compass record (spec docs phase 3), and the TipTap node view that mounts it.
 *
 * Everything shown comes from the server's live answer. The title stored in the markdown link is only a cached hint and is deliberately
 * not an input here, so a stale or hostile cached title can never be displayed as the record's name. The card has no edit actions:
 * removing or replacing an embed is a later phase, and the document is never edited by loading a card.
 */
import { useEffect, useRef } from "react";
import Link from "next/link";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { isDocEmbedKind, type DocEmbedKind } from "@/lib/doc-embeds";
import { DOC_EMBED_KIND_LABEL, humanizeStatus } from "@/lib/spec-docs/labels";
import { useEmbedEntry, useNearViewport, type EmbedEntry } from "@/components/docs/doc-embed-cards";

/** Server hrefs are app-relative; anything else (a scheme, a protocol-relative URL) is not rendered as a link. */
export function safeInternalHref(href: string): string | null {
  return href.startsWith("/") && !href.startsWith("//") && !href.includes("\\") ? href : null;
}

const CARD = "min-w-0 max-w-full rounded-lg border border-border-default bg-surface-card px-3 py-2.5 sm:px-4 sm:py-3";
const KIND = "text-xs font-medium uppercase tracking-wide text-text-subtle";

function KindRow({ kind, status }: { kind: DocEmbedKind; status?: string | null }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className={KIND}>{DOC_EMBED_KIND_LABEL[kind]}</span>
      {status ? <span className="rounded-full bg-status-neutral-surface px-2 py-0.5 text-xs text-status-neutral">{humanizeStatus(status)}</span> : null}
    </div>
  );
}

/** Presentational: `entry` undefined is the loading state. */
export function SpecEmbedCard({ kind, entry }: { kind: DocEmbedKind; entry: EmbedEntry | undefined }) {
  if (!entry) {
    return (
      <div data-slot="spec-embed-card" data-state="loading" aria-busy="true" className={CARD}>
        <KindRow kind={kind} />
        <div className="mt-2 h-4 w-2/3 max-w-xs animate-pulse rounded bg-surface-inset" aria-hidden="true" />
        <span className="sr-only">Loading {DOC_EMBED_KIND_LABEL[kind].toLowerCase()}</span>
      </div>
    );
  }
  if (entry.status === "error") {
    return (
      <div data-slot="spec-embed-card" data-state="error" className={CARD}>
        <KindRow kind={kind} />
        <p className="mt-1 text-sm text-text-secondary">Could not load this record. Reload the page to try again.</p>
      </div>
    );
  }
  const { card } = entry;
  if (card.state === "unavailable") {
    // Identical for a deleted record, one in another workspace and one the viewer may not see: the card never says which.
    return (
      <div data-slot="spec-embed-card" data-state="unavailable" className={`${CARD} border-dashed`}>
        <KindRow kind={kind} />
        <p className="mt-1 text-sm font-medium text-text-secondary">Record unavailable</p>
        <p className="text-xs text-text-subtle">It may have been deleted, or you may not have access to it.</p>
      </div>
    );
  }
  const href = safeInternalHref(card.href);
  return (
    <div data-slot="spec-embed-card" data-state="ok" role="group" aria-label={`${DOC_EMBED_KIND_LABEL[kind]}: ${card.title}`} className={CARD}>
      <KindRow kind={kind} status={card.status} />
      {href ? (
        <Link href={href} className="mt-1 block break-words text-sm font-medium text-text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {card.title}
        </Link>
      ) : (
        <p className="mt-1 break-words text-sm font-medium text-text-primary">{card.title}</p>
      )}
      {card.facts.length > 0 ? (
        <dl className="mt-1.5 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
          {card.facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 gap-1">
              <dt className="text-text-subtle">{fact.label}</dt>
              <dd className="min-w-0 break-words">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function SpecEmbedLive({ kind, id }: { kind: DocEmbedKind; id: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(containerRef);
  const { entry, request } = useEmbedEntry({ kind, id });
  useEffect(() => {
    if (near) request();
  }, [near, request]);
  return (
    <div ref={containerRef}>
      <SpecEmbedCard kind={kind} entry={entry} />
    </div>
  );
}

/** The node view for the `specEmbed` block node. Attribute `title` (the cached hint) is intentionally never read. */
export function SpecEmbedNodeView({ node }: NodeViewProps) {
  const { kind, id } = node.attrs as { kind: unknown; id: unknown };
  return (
    <NodeViewWrapper data-compass-embed="" className="my-3" contentEditable={false}>
      {isDocEmbedKind(kind) && typeof id === "string" ? <SpecEmbedLive kind={kind} id={id} /> : null}
    </NodeViewWrapper>
  );
}
