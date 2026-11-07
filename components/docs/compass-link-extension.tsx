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
import { useEffect, type MouseEvent } from "react";
import Link from "@tiptap/extension-link";
import { MarkViewContent, ReactMarkViewRenderer, type MarkViewProps } from "@tiptap/react";
import { isDocEmbedKind, type DocEmbedKind } from "@/lib/doc-embeds";
import { isUuid } from "@/lib/canvas-cards";
import { DOC_EMBED_KIND_LABEL } from "@/lib/spec-docs/labels";
import { EntityPill } from "@/components/patterns/entity-pill";
import { useEmbedEntry } from "@/components/docs/doc-embed-cards";
import { safeInternalHref } from "@/components/docs/spec-embed-card";

const COMPASS_HREF = /^compass:\/\/([A-Za-z]+)\/([0-9a-fA-F-]{36})$/;

export function parseCompassHref(href: unknown): { kind: DocEmbedKind; id: string } | null {
  if (typeof href !== "string") return null;
  const match = COMPASS_HREF.exec(href);
  if (!match || !isDocEmbedKind(match[1]) || !isUuid(match[2])) return null;
  return { kind: match[1], id: match[2] };
}

function CompassChip({ kind, id }: { kind: DocEmbedKind; id: string }) {
  const { entry, request } = useEmbedEntry({ kind, id });
  useEffect(() => request(), [request]);
  const card = entry?.status === "ready" ? entry.card : null;
  const ok = card?.state === "ok" ? card : null;
  const href = ok ? safeInternalHref(ok.href) : null;
  const unavailable = card?.state === "unavailable";
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Inside a contenteditable a plain anchor does not navigate; follow the live href ourselves, keeping new-tab modifiers.
    if (!href) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey || event.shiftKey) window.open(href, "_blank", "noopener");
    else window.location.assign(href);
  };
  const data = ok && href ? { kind, typeLabel: DOC_EMBED_KIND_LABEL[kind], title: ok.title, status: ok.status, facts: ok.facts, href } : null;
  const state = ok ? "ok" : unavailable ? "unavailable" : "loading";
  // The pill text is the stored link text (editable in place); the hover card shows the record's LIVE title, status and facts.
  return (
    <EntityPill
      data={data}
      href={href ?? undefined}
      onClick={onClick}
      className={unavailable ? "border-dashed text-text-secondary" : undefined}
      dataAttrs={{ "data-compass-link": "", "data-kind": kind, "data-state": state }}
    >
      <MarkViewContent as="span" />
    </EntityPill>
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
