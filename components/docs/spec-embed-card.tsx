"use client";
/**
 * The card for one embedded Compass record in a spec doc, and the TipTap node view that mounts it.
 *
 * Everything shown comes from the server's live answer. The title stored in the markdown link is only a cached hint and is deliberately
 * not an input here, so a stale or hostile cached title can never be displayed as the record's name.
 *
 * Phase 4 adds editing, with two hard rules:
 *  - A card edit writes the RECORD (through the same endpoint the record's own page uses) and never the document. It makes no editor
 *    transaction, so it cannot trigger the doc's autosave, and the cached title in the markdown is left exactly as stored.
 *  - Controls exist only when the page is editable AND the server said the viewer can write (fail closed); the write itself is authorized
 *    again by the record's endpoint.
 * "Remove" is the one control that edits the DOCUMENT: it deletes the embed paragraph as an ordinary editor transaction (which autosaves like
 * any edit) and never touches the record.
 */
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ChevronRight, MoreHorizontal, Pencil } from "lucide-react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { isDocEmbedKind, type DocEmbedKind } from "@/lib/doc-embeds";
import type { DocEmbedCardView } from "@/lib/canvas-card-data";
import { DOC_EMBED_KIND_LABEL, humanizeStatus } from "@/lib/spec-docs/labels";
import { cardEditSpec, validateCardTitle } from "@/lib/spec-docs/card-edit";
import { peekFact, statusVisual } from "@/lib/spec-docs/embed-visual";
import { KIND_ICON, StatusGlyphIcon, TONE_CLASS } from "@/components/docs/embed-card-icons";
import { PANEL_ENTITY_TYPES, useOptionalPanelContext, type EntityPanelType } from "@/components/panels/panel-context";
import { useEmbedEditing, useEmbedEntry, useNearViewport, type EmbedEntry } from "@/components/docs/doc-embed-cards";

/** Server hrefs are app-relative; anything else (a scheme, a protocol-relative URL) is not rendered as a link. */
export function safeInternalHref(href: string): string | null {
  return href.startsWith("/") && !href.startsWith("//") && !href.includes("\\") ? href : null;
}

function panelTypeOf(kind: string): EntityPanelType | null {
  return (PANEL_ENTITY_TYPES as readonly string[]).includes(kind) ? (kind as EntityPanelType) : null;
}

/**
 * The "Open record" link in an expanded card. For a record the detail side panel can show, a plain primary click opens the panel (the URL gains `?detail=`) so the
 * reader stays on the document, as everywhere else in the app. It stays a real link with the real href, so a modified click (Cmd/Ctrl/
 * Shift/Alt), a middle click and "open in new tab" are left to the browser and still reach the record's full page. Kinds the panel does
 * not show (metric, doc, artifact), and a card rendered with no PanelProvider, navigate by href as before.
 */
function CardTitleLink({ kind, id, href, label, children }: { kind: string; id: string; href: string; label: string; children: React.ReactNode }) {
  const panel = useOptionalPanelContext();
  const panelType = panelTypeOf(kind);
  return (
    <Link
      href={href}
      aria-label={label}
      onClick={(event) => {
        if (!panel || !panelType) return;
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        panel.openPanel(panelType, id);
      }}
      className="inline-flex min-h-9 items-center text-sm text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7"
    >
      {children}
    </Link>
  );
}

const CARD_BOX = "min-w-0 max-w-full rounded-lg border border-border-default bg-surface-card";
const CARD = "min-w-0 max-w-full rounded-lg border border-border-default bg-surface-card px-3 py-2.5 sm:px-4 sm:py-3";
const KIND = "text-xs font-medium uppercase tracking-wide text-text-subtle";
const BUTTON =
  "inline-flex min-h-9 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium text-text-secondary hover:bg-surface-interactive hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7";

/** Thrown when a write succeeded but the card could not be re-read: the record is saved, the card may be stale. */
export class CardRefreshError extends Error {
  constructor() {
    super("The change was saved but the card could not be refreshed");
    this.name = "CardRefreshError";
  }
}

/** Edit capability for one OK card. Present only when the viewer may edit it. `save` resolves once the write succeeded and the card was re-resolved. */
export type CardEditControls = {
  statuses: readonly string[] | null;
  save(field: "title" | "status", value: string): Promise<void>;
};

type FieldState = { saving: boolean; saved: boolean; error: string | null };
const IDLE: FieldState = { saving: false, saved: false, error: null };

function KindRow({ kind, status, trailing }: { kind: DocEmbedKind; status?: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className={KIND}>{DOC_EMBED_KIND_LABEL[kind]}</span>
      {status}
      {trailing ? <span className="ml-auto flex items-center gap-1">{trailing}</span> : null}
    </div>
  );
}

/** A decorative icon with a hover/focus tooltip. `ariaLabel` names it for assistive tech; the tooltip text is for sighted pointer users. */
function IconTip({ ariaLabel, tip, className, children }: { ariaLabel: string; tip: string | null; className?: string; children: React.ReactNode }) {
  return (
    <span role="img" aria-label={ariaLabel} className={`group/tip relative inline-flex shrink-0 items-center justify-center ${className ?? ""}`}>
      {children}
      {tip ? (
        <span aria-hidden="true" className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[11px] text-background opacity-0 transition-opacity group-hover/tip:opacity-100">
          {tip}
        </span>
      ) : null}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className="rounded-full bg-status-neutral-surface px-2 py-0.5 text-xs text-status-neutral">{humanizeStatus(status)}</span>;
}

/** "Remove from document" for an OK card, behind a small overflow button. Closes on Escape or an outside click. */
function CardMenu({ label, onRemove }: { label: string; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  return (
    <span ref={rootRef} className="relative" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
      <button type="button" data-testid="embed-card-menu" aria-label={`Actions for ${label}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)} className={BUTTON}>
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </button>
      {open ? (
        <div id={menuId} role="menu" className="absolute right-0 top-full z-20 mt-1 min-w-44 rounded-md border border-border-default bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
          <button type="button" role="menuitem" data-testid="embed-remove" autoFocus onClick={() => { setOpen(false); onRemove(); }} className="flex min-h-9 w-full items-center rounded px-2 text-left text-sm text-text-primary hover:bg-surface-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Remove from document
          </button>
          <p className="px-2 pb-1 pt-0.5 text-xs text-text-subtle">The record is not deleted.</p>
        </div>
      ) : null}
    </span>
  );
}

function OkCard({ kind, card, edit, onRemove, defaultExpanded }: { kind: DocEmbedKind; card: Extract<DocEmbedCardView, { state: "ok" }>; edit: CardEditControls | null; onRemove: (() => void) | null; defaultExpanded: boolean }) {
  const href = safeInternalHref(card.href);
  // View state only: opening or closing a card never makes an editor transaction, so it cannot trigger the doc's autosave.
  const [expanded, setExpanded] = useState(defaultExpanded);
  const bodyId = useId();
  const [titleField, setTitleField] = useState<FieldState>(IDLE);
  const [statusField, setStatusField] = useState<FieldState>(IDLE);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draft, setDraft] = useState(card.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  // The status the person picked while its write is in flight; cleared when the write ends, so a failure shows the server's value again.
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const mounted = useRef(true);
  const settled = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const label = `${DOC_EMBED_KIND_LABEL[kind]}: ${card.title}`;
  const statusControl = edit?.statuses && card.status && edit.statuses.includes(card.status) ? edit : null;

  async function run(field: "title" | "status", value: string, set: (state: FieldState) => void, failure: string) {
    if (!edit) return;
    // Messages belong to the latest attempt: starting one wipes what an earlier attempt (on either field) left behind.
    setTitleField((previous) => (previous.saving ? previous : IDLE));
    setStatusField((previous) => (previous.saving ? previous : IDLE));
    set({ saving: true, saved: false, error: null });
    try {
      await edit.save(field, value);
      if (mounted.current) set({ saving: false, saved: true, error: null });
    } catch (error) {
      const stale = error instanceof CardRefreshError;
      if (mounted.current) set({ saving: false, saved: false, error: stale ? "Saved, but this card could not be refreshed. Reload the page to see it." : failure });
    } finally {
      if (mounted.current && field === "status") setPendingStatus(null);
      if (mounted.current && field === "title") setEditingTitle(false);
    }
  }

  function commitTitle() {
    if (settled.current) return;
    const checked = validateCardTitle(draft);
    if (!checked.ok) {
      setTitleError(checked.error);
      return;
    }
    settled.current = true;
    setTitleError(null);
    if (checked.title === card.title) {
      setEditingTitle(false);
      return;
    }
    void run("title", checked.title, setTitleField, "Could not save the title. The previous title was kept.");
  }

  function cancelTitle() {
    settled.current = true;
    setTitleError(null);
    setDraft(card.title);
    setEditingTitle(false);
  }

  function beginTitle() {
    settled.current = false;
    setDraft(card.title);
    setTitleError(null);
    setTitleField(IDLE);
    setEditingTitle(true);
  }

  const status = statusControl ? (
    <select
      data-testid="embed-status-select"
      aria-label={`Status of ${card.title}`}
      value={pendingStatus ?? card.status ?? ""}
      disabled={statusField.saving}
      onChange={(event) => {
        const next = event.target.value;
        if (next === card.status) return;
        setPendingStatus(next);
        void run("status", next, setStatusField, "Could not save the status. The previous status was kept.");
      }}
      className="min-h-9 rounded-full border border-border-default bg-status-neutral-surface px-2 py-0.5 text-xs text-status-neutral focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:min-h-7"
    >
      {(statusControl.statuses ?? []).map((value) => (
        <option key={value} value={value}>{humanizeStatus(value)}</option>
      ))}
    </select>
  ) : card.status ? (
    <StatusPill status={card.status} />
  ) : null;

  const saving = titleField.saving || statusField.saving;
  const saved = !saving && (titleField.saved || statusField.saved);
  const error = titleField.error ?? statusField.error;

  const KindIcon = KIND_ICON[kind];
  const kindLabel = DOC_EMBED_KIND_LABEL[kind];
  const visual = statusVisual(kind, card.status);
  const peek = peekFact(kind, card.facts);

  return (
    <div data-slot="spec-embed-card" data-state="ok" data-expanded={expanded} role="group" aria-label={label} className={CARD_BOX}>
      <button
        type="button"
        data-testid="embed-card-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={() => setExpanded((value) => !value)}
        className="group/head flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-surface-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
      >
        <IconTip ariaLabel={kindLabel} tip={expanded ? null : kindLabel} className="h-6 min-w-6 gap-1.5 rounded-md bg-surface-inset px-1 text-text-secondary">
          <KindIcon className="size-3.5" aria-hidden="true" />
          {expanded ? <span aria-hidden="true" className="pr-1 text-xs font-medium uppercase tracking-wide">{kindLabel}</span> : null}
        </IconTip>
        {visual ? (
          <IconTip ariaLabel={`Status: ${visual.label}`} tip={expanded ? null : visual.label} className={TONE_CLASS[visual.tone]}>
            <StatusGlyphIcon glyph={visual.glyph} className="size-[18px]" />
          </IconTip>
        ) : card.status ? (
          <StatusPill status={card.status} />
        ) : (
          <span aria-hidden="true" className="size-[18px] shrink-0" />
        )}
        <span className={`min-w-0 flex-1 text-sm font-medium text-text-primary ${expanded ? "break-words" : "truncate"}`}>{card.title}</span>
        {!expanded && peek ? <span className="hidden max-w-40 shrink-0 truncate text-xs text-text-subtle sm:inline">{peek}</span> : null}
        <ChevronRight className={`size-4 shrink-0 text-text-subtle transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
      </button>
      {expanded ? (
        <div id={bodyId} className="px-3 pb-3 sm:px-4">
          {editingTitle ? (
            <div>
              <input
                data-testid="embed-title-input"
                aria-label="Title"
                aria-invalid={titleError ? true : undefined}
                autoFocus
                value={draft}
                onChange={(event) => { setDraft(event.target.value); setTitleError(null); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); commitTitle(); }
                  else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelTitle(); }
                }}
                onBlur={() => { if (!validateCardTitle(draft).ok) cancelTitle(); else commitTitle(); }}
                className="min-h-9 w-full rounded-md border border-border-interactive bg-surface-card px-2 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8 sm:text-sm"
              />
              {titleError ? <p role="alert" data-testid="embed-title-error" className="mt-1 text-xs text-status-danger">{titleError}</p> : null}
            </div>
          ) : null}
          {card.facts.length > 0 ? (
            <dl className="mt-1 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
              {card.facts.map((fact) => (
                <div key={fact.label} className="flex min-w-0 gap-1">
                  <dt className="text-text-subtle">{fact.label}</dt>
                  <dd className="min-w-0 break-words">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {statusControl || visual ? status : null}
            {edit ? (
              <button type="button" data-testid="embed-title-edit" aria-label={`Rename ${card.title}`} onClick={beginTitle} className={BUTTON}>
                <Pencil className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
            {onRemove ? <CardMenu label={label} onRemove={onRemove} /> : null}
            {href ? (
              <span className="ml-auto">
                <CardTitleLink kind={card.kind} id={card.id} href={href} label={`Open ${card.title}`}>
                  Open record
                </CardTitleLink>
              </span>
            ) : null}
          </div>
          {edit ? (
            // Always rendered while editable so a save never shifts the card's layout.
            <div className="mt-1 min-h-4 text-xs" aria-live="polite">
              {saving ? <span data-testid="embed-save-state" data-state="saving" className="text-text-subtle">Saving...</span> : null}
              {saved ? <span data-testid="embed-save-state" data-state="saved" className="text-status-success">Saved</span> : null}
              {error ? <span role="alert" data-testid="embed-save-error" className="text-status-danger">{error}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Presentational: `entry` undefined is the loading state. `edit` and `onRemove` are given only to viewers who may use them. */
export function SpecEmbedCard({ kind, entry, edit = null, onRemove = null, defaultExpanded = false }: { kind: DocEmbedKind; entry: EmbedEntry | undefined; edit?: CardEditControls | null; onRemove?: (() => void) | null; defaultExpanded?: boolean }) {
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
        <KindRow
          kind={kind}
          trailing={onRemove ? (
            <button type="button" data-testid="embed-remove" onClick={onRemove} className={BUTTON}>
              Remove
            </button>
          ) : null}
        />
        <p className="mt-1 text-sm font-medium text-text-secondary">Record unavailable</p>
        <p className="text-xs text-text-subtle">It may have been deleted, or you may not have access to it.</p>
      </div>
    );
  }
  return <OkCard kind={kind} card={card} edit={edit} onRemove={onRemove} defaultExpanded={defaultExpanded} />;
}

function SpecEmbedLive({ kind, id, onRemove }: { kind: DocEmbedKind; id: string; onRemove: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(containerRef);
  const { entry, request } = useEmbedEntry({ kind, id });
  const { store, canEdit, patch } = useEmbedEditing();
  useEffect(() => {
    if (near) request();
  }, [near, request]);

  const spec = cardEditSpec(kind);
  const ready = entry?.status === "ready" ? entry.card : null;
  // Edit controls need: the page is editable, the server said this viewer can write, the record resolved, and the kind has a simple edit.
  const edit: CardEditControls | null =
    canEdit && patch && store && spec && ready?.state === "ok"
      ? {
          statuses: spec.statuses,
          async save(field, value) {
            await patch(spec.entityType, id, field, value);
            try {
              await store.refresh({ kind, id });
            } catch {
              throw new CardRefreshError();
            }
          },
        }
      : null;
  // Remove edits the document, so it needs only a writable page; it is offered for a card that is unavailable or resolved (not mid-load or failed).
  const removable = canEdit && ready !== null;

  return (
    <div ref={containerRef}>
      <SpecEmbedCard kind={kind} entry={entry} edit={edit} onRemove={removable ? onRemove : null} />
    </div>
  );
}

/** The node view for the `specEmbed` block node. Attribute `title` (the cached hint) is intentionally never read. */
export function SpecEmbedNodeView({ node, deleteNode }: NodeViewProps) {
  const { kind, id } = node.attrs as { kind: unknown; id: unknown };
  return (
    <NodeViewWrapper data-compass-embed="" className="my-3" contentEditable={false}>
      {isDocEmbedKind(kind) && typeof id === "string" ? <SpecEmbedLive kind={kind} id={id} onRemove={deleteNode} /> : null}
    </NodeViewWrapper>
  );
}
