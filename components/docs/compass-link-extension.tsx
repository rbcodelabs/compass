"use client";
/**
 * CompassLink: the Link mark, taught to keep `compass://` hrefs and to draw them as inline chips.
 *
 * Two jobs:
 *  1. Register `compass` as an allowed protocol. Tiptap's default allow-list rejects it, which silently dropped the mark (and, on the next
 *     save, the link itself) for every `[title](compass://kind/uuid)` that is not a lone-paragraph SpecEmbed card.
 *  2. Render such a link (in prose, a list item or a table cell) as a chip: the stored text stays editable in place, and the record's
 *     LIVE status plus an app-relative href come from the same resolver the block cards use. Serialization is untouched: it is still the
 *     ordinary Link mark, so markdown round-trips byte for byte.
 *
 * Other links keep an ordinary anchor. Without a DocEmbedCardsProvider (e.g. description editors) the chip shows the cached text only.
 */
import { useEffect } from "react";
import Link from "@tiptap/extension-link";
import { MarkViewContent, ReactMarkViewRenderer, type MarkViewProps } from "@tiptap/react";
import { isDocEmbedKind, type DocEmbedKind } from "@/lib/doc-embeds";
import { isUuid } from "@/lib/canvas-cards";
import { humanizeStatus } from "@/lib/spec-docs/labels";
import { useEmbedEntry } from "@/components/docs/doc-embed-cards";
import { safeInternalHref } from "@/components/docs/spec-embed-card";

const COMPASS_HREF = /^compass:\/\/([A-Za-z]+)\/([0-9a-fA-F-]{36})$/;

export function parseCompassHref(href: unknown): { kind: DocEmbedKind; id: string } | null {
  if (typeof href !== "string") return null;
  const match = COMPASS_HREF.exec(href);
  if (!match || !isDocEmbedKind(match[1]) || !isUuid(match[2])) return null;
  return { kind: match[1], id: match[2] };
}

const CHIP =
  "inline-flex max-w-full items-baseline gap-1 rounded-md border border-border-default bg-surface-card px-1.5 py-px align-baseline text-sm text-text-primary no-underline hover:bg-surface-interactive cursor-pointer";

function CompassChip({ kind, id }: { kind: DocEmbedKind; id: string }) {
  const { entry, request } = useEmbedEntry({ kind, id });
  useEffect(() => request(), [request]);
  const card = entry?.status === "ready" ? entry.card : null;
  const ok = card?.state === "ok" ? card : null;
  const href = ok ? safeInternalHref(ok.href) : null;
  const unavailable = card?.state === "unavailable";
  return (
    <a
      data-compass-link=""
      data-kind={kind}
      data-state={ok ? "ok" : unavailable ? "unavailable" : "loading"}
      href={href ?? undefined}
      title={unavailable ? "Record unavailable" : undefined}
      className={`${CHIP}${unavailable ? " border-dashed text-text-secondary" : ""}`}
      onClick={(event) => {
        // Inside a contenteditable a plain anchor does not navigate; follow the live href ourselves, keeping new-tab modifiers.
        if (!href) return;
        event.preventDefault();
        if (event.metaKey || event.ctrlKey || event.shiftKey) window.open(href, "_blank", "noopener");
        else window.location.assign(href);
      }}
    >
      <MarkViewContent as="span" />
      {ok?.status ? (
        <span className="shrink-0 rounded-full bg-status-neutral-surface px-1.5 text-xs text-status-neutral" contentEditable={false}>
          {humanizeStatus(ok.status)}
        </span>
      ) : null}
    </a>
  );
}

function LinkMarkView({ mark }: MarkViewProps) {
  const href = mark.attrs.href as string | null;
  const ref = parseCompassHref(href);
  if (ref) return <CompassChip kind={ref.kind} id={ref.id} />;
  return (
    <a href={href ?? undefined} target={mark.attrs.target ?? undefined} rel={mark.attrs.rel ?? undefined} className={mark.attrs.class ?? undefined}>
      <MarkViewContent as="span" />
    </a>
  );
}

export const CompassLink = Link.extend({
  addMarkView() {
    return ReactMarkViewRenderer(LinkMarkView);
  },
});
