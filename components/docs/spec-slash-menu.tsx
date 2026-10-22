"use client";
/**
 * The "/" menu of the spec doc editor (spec docs phase 4): create a new record, then insert its embed card at the cursor.
 *
 * What it can create is decided by the doc's scope links, which the server rendered into the page (never typed by the user):
 *  - an Assumption needs a solution scope (the same `addAssumption` the solution page uses);
 *  - a Task is linked to the doc's scope (the same `addLinkedTask` the record pages use).
 * Experiments are not offered: their create action needs a hypothesis, a method and a kill condition, i.e. a further form. A doc with no
 * scope offers nothing and the menu never opens (fail closed). Both creators authorize the caller themselves, so a viewer without write
 * access gets the same refusal here as on the record's page.
 *
 * Order of events, so nothing is ever lost: (1) the record is created; (2) only if that succeeded, the "/query" paragraph is replaced by
 * one embed paragraph, an ordinary editor transaction that autosaves like any edit. If the later autosave fails the record still exists;
 * it is never rolled back. A failed create inserts nothing and shows the error.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { normalizeEmbedTitle, type DocEmbedKind } from "@/lib/doc-embeds";
import { dismissSlash, getSlashState, type SlashController, type SlashState } from "@/components/docs/spec-slash-extension";

export type SlashScope = { scopeType: "SOLUTION" | "OPPORTUNITY"; scopeId: string; title: string };
export type CreatedRecord = { id: string; title: string };

/** How records get created. The defaults call the existing server actions; tests inject fakes. */
export type RecordCreators = {
  createAssumption(solutionId: string, title: string): Promise<CreatedRecord>;
  createTask(scope: { scopeType: "SOLUTION" | "OPPORTUNITY"; scopeId: string }, title: string): Promise<CreatedRecord>;
};

export function defaultRecordCreators(input: { orgSlug: string; workspaceSlug: string; revalidatePathStr: string }): RecordCreators {
  return {
    async createAssumption(solutionId, title) {
      // Loaded on use so merely mounting the editor does not pull the discovery action module into every doc page.
      const { addAssumption } = await import("@/app/[orgSlug]/[workspaceSlug]/discovery/actions");
      const created = await addAssumption(solutionId, { title, riskLevel: "MEDIUM" }, input.revalidatePathStr);
      return { id: created.id, title: created.title };
    },
    async createTask(scope, title) {
      const { addLinkedTask } = await import("@/app/[orgSlug]/[workspaceSlug]/tasks/actions");
      const created = await addLinkedTask(input.orgSlug, input.workspaceSlug, scope.scopeType, scope.scopeId, { title }, input.revalidatePathStr);
      return { id: created.id, title: created.title };
    },
  };
}

type CommandId = "assumption" | "task";
type Command = { id: CommandId; kind: DocEmbedKind; label: string; hint: string };

/** The commands this doc's scopes allow. Empty means the menu never opens. */
export function commandsForScopes(scopes: readonly SlashScope[]): Command[] {
  const solution = scopes.find((scope) => scope.scopeType === "SOLUTION");
  const taskScope = solution ?? scopes[0];
  const commands: Command[] = [];
  if (solution) commands.push({ id: "assumption", kind: "assumption", label: "Assumption", hint: `New assumption on ${solution.title}` });
  if (taskScope) commands.push({ id: "task", kind: "task", label: "Task", hint: `New task linked to ${taskScope.title}` });
  return commands;
}

type Step = { phase: "pick" } | { phase: "title"; command: Command; title: string; creating: boolean; error: string | null };

/** Replace the "/query" paragraph (found again from where it was, in case the document moved) with one embed paragraph. */
export function insertEmbedBlock(editor: Editor, anchor: number, embed: { kind: DocEmbedKind; id: string; title: string }): boolean {
  const { state } = editor;
  const type = state.schema.nodes.specEmbed;
  if (!type) return false;
  const node = type.create({ kind: embed.kind, id: embed.id, title: normalizeEmbedTitle(embed.title) ?? "" });
  const at = anchor >= 0 && anchor <= state.doc.content.size ? state.doc.nodeAt(anchor) : null;
  const tr = state.tr;
  if (at && at.type.name === "paragraph" && at.textContent.startsWith("/")) {
    tr.replaceWith(anchor, anchor + at.nodeSize, node);
  } else {
    // The "/" paragraph is gone (it was edited away while the record was being created): put the card after the block the cursor is in.
    const $to = state.selection.$to;
    tr.insert($to.depth >= 1 ? $to.after(1) : $to.pos, node);
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function SpecSlashMenu({
  editor,
  controller,
  scopes,
  creators,
}: {
  editor: Editor | null;
  controller: SlashController;
  scopes: readonly SlashScope[];
  creators: RecordCreators;
}) {
  const commands = useMemo(() => commandsForScopes(scopes), [scopes]);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [step, setStep] = useState<Step>({ phase: "pick" });
  const [highlight, setHighlight] = useState(0);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const anchorRef = useRef(-1);
  const slashRef = useRef<SlashState | null>(null);
  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  // Commands are on only while there is something to offer; the plugin ignores every key otherwise.
  useEffect(() => {
    controller.setEnabled(Boolean(editor) && commands.length > 0);
    return () => controller.setEnabled(false);
  }, [controller, editor, commands]);

  useEffect(() => {
    if (!editor) return;
    const read = () => {
      const next = getSlashState(editor.state);
      // A new query, or the menu opening, starts the pick over.
      if (!slashRef.current || slashRef.current.query !== next.query || slashRef.current.active !== next.active) setHighlight(0);
      slashRef.current = next;
      setSlash((previous) => (previous && previous.active === next.active && previous.from === next.from && previous.query === next.query ? previous : next));
      // Keep the anchor on the "/" paragraph while a record is being created and the document keeps changing.
      if (stepRef.current.phase === "title") anchorRef.current = next.active ? next.from : anchorRef.current;
    };
    const onTransaction = ({ transaction }: { transaction: { mapping: { map(pos: number, assoc?: number): number }; docChanged: boolean } }) => {
      if (stepRef.current.phase === "title" && transaction.docChanged) anchorRef.current = transaction.mapping.map(anchorRef.current, -1);
      read();
    };
    editor.on("transaction", onTransaction);
    read();
    return () => {
      editor.off("transaction", onTransaction);
      controller.setKeyHandler(null);
    };
  }, [editor, controller]);

  const active = Boolean(slash?.active) || step.phase === "title";
  const query = slash?.query ?? "";
  const visible = useMemo(() => commands.filter((command) => command.label.toLowerCase().startsWith(query.toLowerCase())), [commands, query]);


  const close = useCallback(
    (refocus: boolean) => {
      setStep({ phase: "pick" });
      if (!editor) return;
      const tr = editor.state.tr;
      dismissSlash(tr);
      editor.view.dispatch(tr);
      if (refocus) editor.view.focus();
    },
    [editor]
  );

  const choose = useCallback(
    (command: Command) => {
      if (!slash) return;
      anchorRef.current = slash.from;
      setStep({ phase: "title", command, title: "", creating: false, error: null });
    },
    [slash]
  );

  const create = useCallback(
    async (command: Command, rawTitle: string) => {
      const title = rawTitle.trim();
      if (!title) {
        setStep({ phase: "title", command, title: rawTitle, creating: false, error: "Give it a title first." });
        return;
      }
      setStep({ phase: "title", command, title: rawTitle, creating: true, error: null });
      let created: CreatedRecord;
      try {
        const solution = scopes.find((scope) => scope.scopeType === "SOLUTION");
        const taskScope = solution ?? scopes[0];
        if (command.id === "assumption") {
          if (!solution) throw new Error("missing scope");
          created = await creators.createAssumption(solution.scopeId, title);
        } else {
          if (!taskScope) throw new Error("no scope");
          created = await creators.createTask({ scopeType: taskScope.scopeType, scopeId: taskScope.scopeId }, title);
        }
      } catch {
        // Nothing was inserted and nothing was created that we know of; keep the title so the person can retry.
        setStep({ phase: "title", command, title: rawTitle, creating: false, error: `Could not create the ${command.label.toLowerCase()}. Nothing was added to the document.` });
        return;
      }
      if (!editor) return;
      insertEmbedBlock(editor, anchorRef.current, { kind: command.kind, id: created.id, title: created.title || title });
      setStep({ phase: "pick" });
      editor.view.focus();
    },
    [creators, editor, scopes]
  );

  // Keys while the menu is open and the editor still has focus (pick phase).
  useEffect(() => {
    controller.setKeyHandler((event) => {
      if (stepRef.current.phase !== "pick") return false;
      if (event.key === "Escape") { close(false); return true; }
      if (visible.length === 0) return false;
      if (event.key === "ArrowDown") { setHighlight((index) => (index + 1) % visible.length); return true; }
      if (event.key === "ArrowUp") { setHighlight((index) => (index - 1 + visible.length) % visible.length); return true; }
      if (event.key === "Enter" || event.key === "Tab") { choose(visible[Math.min(highlight, visible.length - 1)]); return true; }
      return false;
    });
  }, [controller, close, choose, visible, highlight]);

  // Fixed to the viewport at the cursor so the menu never takes space in (or shifts) the document, clamped to the visible area (390px phones).
  useLayoutEffect(() => {
    if (!editor || !active) return;
    const place = () => {
      const pos = Math.min(Math.max((slash?.active ? slash.from : anchorRef.current) + 1, 0), editor.state.doc.content.size);
      let coords: { bottom: number; left: number };
      try { coords = editor.view.coordsAtPos(pos); } catch { coords = { bottom: 0, left: 0 }; }
      const vv = window.visualViewport;
      const vw = vv?.width ?? window.innerWidth;
      const ox = vv?.offsetLeft ?? 0;
      const margin = 8;
      const width = Math.min(320, vw - margin * 2);
      setBox({ top: coords.bottom + 6, left: Math.min(Math.max(coords.left, ox + margin), ox + vw - width - margin), width });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [editor, active, slash]);

  if (!editor || !active || commands.length === 0 || typeof document === "undefined") return null;
  if (step.phase === "pick" && visible.length === 0) return null;

  const style = box ? { top: box.top, left: box.left, width: box.width } : { top: 0, left: 0, width: 280, visibility: "hidden" as const };
  return createPortal(
    <div
      data-testid="spec-slash-menu"
      style={{ position: "fixed", ...style }}
      className="z-50 max-h-[min(320px,60vh)] overflow-y-auto rounded-lg border border-border-default bg-surface-overlay p-1 shadow-lg"
      // Clicking the menu must not move the editor selection (that would close it before the click lands).
      onMouseDown={(event) => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); }}
    >
      {step.phase === "pick" ? (
        <ul role="listbox" aria-label="Insert a record" className="m-0 list-none p-0">
          {visible.map((command, index) => (
            <li key={command.id} role="option" aria-selected={index === highlight} data-testid={`spec-slash-${command.id}`}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => choose(command)}
                onMouseEnter={() => setHighlight(index)}
                className={`flex min-h-11 w-full min-w-0 flex-col items-start justify-center rounded-md px-2 py-1.5 text-left sm:min-h-9 ${index === highlight ? "bg-surface-interactive" : ""} hover:bg-surface-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
              >
                <span className="text-sm font-medium text-text-primary">{command.label}</span>
                <span className="w-full truncate text-xs text-text-subtle">{command.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <form
          className="flex flex-col gap-1.5 p-1"
          onSubmit={(event) => { event.preventDefault(); if (!step.creating) void create(step.command, step.title); }}
        >
          <label htmlFor="spec-slash-title" className="text-xs font-medium text-text-subtle">New {step.command.label.toLowerCase()}</label>
          <input
            id="spec-slash-title"
            data-testid="spec-slash-title"
            autoFocus
            value={step.title}
            disabled={step.creating}
            placeholder="Title"
            onChange={(event) => setStep({ ...step, title: event.target.value, error: null })}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
            }}
            className="min-h-10 w-full rounded-md border border-border-interactive bg-surface-card px-2 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:min-h-8 sm:text-sm"
          />
          {step.error ? <p role="alert" data-testid="spec-slash-error" className="text-xs text-status-danger">{step.error}</p> : null}
          <div className="flex justify-end gap-1">
            <button type="button" onClick={() => close(true)} className="min-h-9 rounded-md px-2 text-xs font-medium text-text-secondary hover:bg-surface-interactive sm:min-h-7">Cancel</button>
            <button type="submit" disabled={step.creating} data-testid="spec-slash-create" className="min-h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-60 sm:min-h-7">
              {step.creating ? "Creating..." : "Create and insert"}
            </button>
          </div>
        </form>
      )}
    </div>,
    document.body
  );
}
