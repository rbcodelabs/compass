"use client";
/**
 * CompassLink: the Link mark, taught to keep `compass://` hrefs and to draw both `compass://` and GitHub PR links as inline smart chips.
 *
 * Jobs:
 *  1. Register `compass` as an allowed protocol. Tiptap's default allow-list rejects it, which silently dropped the mark (and, on the next
 *     save, the link itself) for every `[title](compass://kind/uuid)` that is not a lone-paragraph SpecEmbed card.
 *  2. Render `compass://` links and `https://github.com/<owner>/<repo>/pull/<n>` links (in prose, a list item or a table cell) as live
 *     chips: `<MarkViewContent as="span" />` stays mounted in place so cursor movement, inline editing, comment anchors, and Markdown
 *     round-tripping remain intact.
 *  3. When a user pastes or autolinks a bare GitHub PR URL, rewrite the link text once resolved to `#<number> <Title>` in its own undoable
 *     step, while preserving custom `[label](url)` text untouched and falling back to a plain `<a>` when unapproved, unconfigured, or 404.
 */
import { useEffect, type MouseEvent } from "react";
import Link from "@tiptap/extension-link";
import { MarkViewContent, ReactMarkViewRenderer, type Editor, type MarkViewProps } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { isDocEmbedKind, type DocEmbedKind } from "@/lib/doc-embeds";
import { isUuid } from "@/lib/canvas-cards";
import { DOC_EMBED_KIND_LABEL } from "@/lib/spec-docs/labels";
import { EntityPill } from "@/components/patterns/entity-pill";
import { useEmbedEntry } from "@/components/docs/doc-embed-cards";
import { safeInternalHref } from "@/components/docs/spec-embed-card";
import { useOptionalPanelContext } from "@/components/panels/panel-context";
import { useWorkItemLinkScope } from "@/components/work-item-link-scope";
import { PullRequestPill } from "@/components/github/pull-request-chip";
import { usePullRequest } from "@/components/github/use-pull-request";
import {
  formatPullRequestLabel,
  isBarePullRequestLabel,
  parsePullRequestUrl,
  pullRequestPanelId,
  type PullRequestRef,
} from "@/lib/github-pull-request-links";

const COMPASS_HREF = /^compass:\/\/([A-Za-z]+)\/([0-9a-fA-F-]{36})$/;

export function parseCompassHref(href: unknown): { kind: DocEmbedKind; id: string } | null {
  if (typeof href !== "string") return null;
  const match = COMPASS_HREF.exec(href);
  if (!match || !isDocEmbedKind(match[1]) || !isUuid(match[2])) return null;
  return { kind: match[1], id: match[2] };
}

type BarePrRange = { from: number; to: number; href: string; pr: PullRequestRef };

function collectBarePrRanges(doc: PMNode): BarePrRange[] {
  const ranges: BarePrRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let runHref: string | null = null;
    let runFrom = 0;
    let runTo = 0;
    let runText = "";

    const flush = () => {
      if (runHref) {
        const pr = parsePullRequestUrl(runHref);
        if (pr && isBarePullRequestLabel(runText, pr, runHref)) {
          ranges.push({ from: runFrom, to: runTo, href: runHref, pr });
        }
      }
      runHref = null;
      runText = "";
    };

    node.forEach((child, offset) => {
      const linkMark = child.isText ? child.marks.find((m) => m.type.name === "link") : undefined;
      const href = typeof linkMark?.attrs.href === "string" ? linkMark.attrs.href : null;
      const childFrom = pos + 1 + offset;
      const childTo = childFrom + child.nodeSize;
      if (href && child.text) {
        if (runHref === href && runTo === childFrom) {
          runTo = childTo;
          runText += child.text;
        } else {
          flush();
          runHref = href;
          runFrom = childFrom;
          runTo = childTo;
          runText = child.text;
        }
      } else {
        flush();
      }
    });
    flush();
    return false;
  });
  return ranges;
}

const prBareLinkPluginKey = new PluginKey<DecorationSet>("prBareLinkPending");

function createBarePrRewritePlugin() {
  return new Plugin<DecorationSet>({
    key: prBareLinkPluginKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, set, oldState, newState) {
        if (tr.getMeta("preventUpdate")) return DecorationSet.empty;

        let next = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(prBareLinkPluginKey) as { clearHref?: string } | undefined;
        if (meta?.clearHref) {
          const toRemove = next.find(undefined, undefined, (spec: { href?: string }) => spec.href === meta.clearHref);
          if (toRemove.length) next = next.remove(toRemove);
        }

        if (!tr.docChanged || tr.getMeta("history$") || tr.getMeta("prSmartChipRewrite")) {
          return next;
        }

        const nextRanges = collectBarePrRanges(newState.doc);
        if (nextRanges.length === 0) return next;

        const oldRanges = collectBarePrRanges(oldState.doc);
        // Whole-doc reload of identical bare PR links (e.g. setContent with the same markdown) is not a new paste.
        if (
          oldRanges.length === nextRanges.length &&
          oldRanges.every((r, idx) => r.href === nextRanges[idx]?.href) &&
          oldState.doc.textContent === newState.doc.textContent
        ) {
          return next;
        }

        const mappedOld = new Set(
          oldRanges.map((r) => `${r.href}@${tr.mapping.map(r.from, 1)}:${tr.mapping.map(r.to, -1)}`),
        );
        const existing = new Set(
          next.find().map((d) => `${(d.spec as { href?: string }).href ?? ""}@${d.from}:${d.to}`),
        );

        const added: Decoration[] = [];
        for (const r of nextRanges) {
          const key = `${r.href}@${r.from}:${r.to}`;
          if (!mappedOld.has(key) && !existing.has(key)) {
            added.push(Decoration.inline(r.from, r.to, {}, { href: r.href }));
          }
        }
        return added.length ? next.add(newState.doc, added) : next;
      },
    },
  });
}

function marksAtRange(doc: PMNode, from: number, to: number, href: string): readonly Mark[] | null {
  let found: readonly Mark[] | null = null;
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    const hasMatchingLink = node.marks.some((m) => m.type.name === "link" && m.attrs.href === href);
    if (hasMatchingLink && !found) found = node.marks;
    return false;
  });
  return found;
}

function rewritePendingBarePrLinks(editor: Editor, href: string, pr: PullRequestRef, nextLabel: string): void {
  const { state } = editor;
  const set = prBareLinkPluginKey.getState(state);
  const pending = set?.find(undefined, undefined, (spec: { href?: string }) => spec.href === href) ?? [];
  if (pending.length === 0) return;

  const sorted = [...pending].sort((a, b) => b.from - a.from);
  const wasEmptySelection = state.selection.empty;
  let nextCursor = state.selection.from;
  let tr = closeHistory(state.tr);
  let replacedAny = false;

  for (const dec of sorted) {
    const { from, to } = dec;
    if (from < 0 || to > state.doc.content.size || from >= to) continue;
    const text = state.doc.textBetween(from, to, "", "");
    if (!isBarePullRequestLabel(text, pr, href)) continue;
    const marks = marksAtRange(state.doc, from, to, href);
    if (!marks) continue;
    tr = tr.replaceWith(from, to, state.schema.text(nextLabel, marks));
    if (wasEmptySelection && nextCursor >= to) {
      nextCursor += nextLabel.length - (to - from);
    } else if (wasEmptySelection && nextCursor > from) {
      nextCursor = from + nextLabel.length;
    }
    replacedAny = true;
  }

  tr.setMeta(prBareLinkPluginKey, { clearHref: href });
  tr.setMeta("prSmartChipRewrite", href);
  tr.setMeta("preventAutolink", true);

  const linkMarkType = state.schema.marks.link;
  if (replacedAny && wasEmptySelection) {
    const clamped = Math.max(0, Math.min(nextCursor, tr.doc.content.size));
    tr.setSelection(TextSelection.create(tr.doc, clamped));
    if (linkMarkType) {
      tr.removeStoredMark(linkMarkType);
    }
  }

  editor.view.dispatch(tr);
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

function PullRequestDocChip({
  editor,
  mark,
  href,
  pr,
}: {
  editor: Editor;
  mark: Mark;
  href: string;
  pr: PullRequestRef;
}) {
  const panels = useOptionalPanelContext();
  const scope = useWorkItemLinkScope();
  const orgSlug = scope?.orgSlug ?? "";
  const workspaceSlug = scope?.workspaceSlug ?? "";
  const { summary, settled } = usePullRequest(orgSlug, workspaceSlug, scope ? pr : null);

  useEffect(() => {
    if (!summary) return;
    let cancelled = false;
    const flush = () => {
      if (cancelled || !editor.isEditable || editor.isDestroyed) return;
      const pending = prBareLinkPluginKey.getState(editor.state)?.find(undefined, undefined, (s: { href?: string }) => s.href === href);
      if (!pending?.length) return;
      queueMicrotask(() => {
        if (!cancelled && editor.isEditable && !editor.isDestroyed) {
          rewritePendingBarePrLinks(editor, href, pr, formatPullRequestLabel(summary));
        }
      });
    };
    flush();
    editor.on("transaction", flush);
    return () => {
      cancelled = true;
      editor.off("transaction", flush);
    };
  }, [editor, href, pr, summary]);

  const activeSummary = scope ? summary : null;

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.altKey) return;
    // Inside contenteditable, handle modified clicks explicitly so Cmd/Ctrl-click opens GitHub in a new tab.
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      event.preventDefault();
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    event.preventDefault();
    if (panels) panels.openPanel("pullRequest", pullRequestPanelId(pr));
    else window.open(href, "_blank", "noopener,noreferrer");
  };

  return (
    <PullRequestPill
      summary={activeSummary}
      href={href}
      target={(mark.attrs.target as string | null) ?? undefined}
      rel={(mark.attrs.rel as string | null) ?? undefined}
      plainClassName={(mark.attrs.class as string | null) ?? undefined}
      onClick={onClick}
      nonEditableChrome
      dataAttrs={{
        "data-github-pr-link": activeSummary ? "ready" : scope && !settled ? "loading" : undefined,
      }}
    >
      <MarkViewContent as="span" />
    </PullRequestPill>
  );
}

function LinkMarkView({ editor, mark }: MarkViewProps) {
  const href = mark.attrs.href as string | null;
  const ref = parseCompassHref(href);
  if (ref) return <CompassChip kind={ref.kind} id={ref.id} />;
  const pr = href ? parsePullRequestUrl(href) : null;
  if (href && pr) return <PullRequestDocChip editor={editor} mark={mark} href={href} pr={pr} />;
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
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), createBarePrRewritePlugin()];
  },
});
