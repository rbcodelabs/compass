"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckIcon, GripVerticalIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  OPTION_COLOR_PRESETS,
  addOptionLabels,
  moveOption,
  optionListIssues,
  removeOption,
  renameOption,
  setOptionColor,
  splitPastedOptionLabels,
} from "@/lib/option-list";
import type { SelectOptionInput } from "@/lib/shared-field-options";
import { cn } from "@/lib/utils";

/**
 * Row-per-option editor for SELECT / MULTI_SELECT picklists.
 *
 * Controlled: the parent owns `value` and receives every edit through
 * `onChange`. Existing options travel with their stored `value` and `color`,
 * so renaming a label never re-derives the value that CustomFieldValues point
 * at; brand-new options are label-only and get their slug on save.
 *
 * Rows reorder by dragging their grip handle (pointer, touch, or keyboard:
 * Space to pick up, arrows to move, Space to drop, Escape to cancel), or with
 * Alt+↑/↓ while editing a label.
 */
export function OptionListEditor({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: SelectOptionInput[];
  onChange: (options: SelectOptionInput[]) => void;
  disabled?: boolean;
}) {
  const baseId = useId();
  const rowKeys = useStableRowKeys(value.length);
  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const pendingFocus = useRef<string | null>(null);
  const [colorOpenFor, setColorOpenFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click on the handle
    // is still just a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // A short press-and-hold on touch, so swiping over the list still scrolls.
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const issues = optionListIssues(value);

  useEffect(() => {
    if (!pendingFocus.current) return;
    inputRefs.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= value.length) return;
    rowKeys.move(from, to);
    onChange(moveOption(value, from, to));
  }

  function moveFromLabel(from: number, to: number) {
    // Keep the caret with the row that moved, so repeated Alt+Arrow keeps moving it.
    pendingFocus.current = rowKeys.keys[from];
    move(from, to);
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over) return;
    move(rowKeys.keys.indexOf(String(active.id)), rowKeys.keys.indexOf(String(over.id)));
  }

  /** Screen-reader copy that names options by label rather than internal ids. */
  function describe(id: UniqueIdentifier) {
    const index = rowKeys.keys.indexOf(String(id));
    return { name: value[index]?.label.trim() || `option ${index + 1}`, position: index + 1 };
  }
  const total = value.length;
  // dnd-kit reports the row as "over" itself the instant it is picked up;
  // announcing that would immediately replace "Picked up …" in the live region.
  const hasMoved = useRef(false);
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      hasMoved.current = false;
      return `Picked up ${describe(active.id).name}.`;
    },
    onDragOver: ({ active, over }) => {
      if (over?.id === active.id && !hasMoved.current) return undefined;
      hasMoved.current = true;
      return over
        ? `Moved ${describe(active.id).name} to position ${describe(over.id).position} of ${total}.`
        : `${describe(active.id).name} is no longer over the list.`;
    },
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${describe(active.id).name} at position ${describe(over.id).position} of ${total}.`
        : `Dropped ${describe(active.id).name}.`,
    onDragCancel: ({ active }) =>
      `Reordering cancelled. ${describe(active.id).name} returned to position ${describe(active.id).position}.`,
  };

  function remove(index: number) {
    const key = rowKeys.keys[index];
    rowKeys.remove(index);
    if (colorOpenFor === key) setColorOpenFor(null);
    onChange(removeOption(value, index));
  }

  function add(labels: string[]) {
    const result = addOptionLabels(value, labels);
    if (result.blank) {
      setAddMessage("Type a label, then press Enter.");
      return false;
    }
    const added = result.options.length - value.length;
    if (added > 0) {
      rowKeys.append(added);
      onChange(result.options);
    }
    if (result.duplicates.length === 0) {
      setAddMessage(null);
    } else if (added === 0 && result.duplicates.length === 1) {
      setAddMessage(`“${result.duplicates[0]}” is already in the list.`);
    } else {
      setAddMessage(
        `Skipped ${result.duplicates.length === 1 ? "a duplicate" : "duplicates"} already in the list: ${result.duplicates.join(", ")}`
      );
    }
    return added > 0;
  }

  function handleAddKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    // Enter here means "add this option", never "submit the surrounding form".
    event.preventDefault();
    // Typed text is one label verbatim, so a label may contain a comma.
    if (add([draft])) {
      setDraft("");
    }
  }

  function handleAddPaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    // Pasting a list (lines, or a comma-separated line) adds each entry; any
    // other paste lands in the input normally so it can be edited first.
    if (!/[\r\n,]/.test(text)) return;
    event.preventDefault();
    add(splitPastedOptionLabels(text));
  }

  const labelId = `${baseId}-label`;
  const addHelpId = `${baseId}-add-help`;

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm leading-none font-medium select-none">
        {label}
      </span>

      {value.length > 0 && (
        <DndContext
          id={`${baseId}-dnd`}
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={DRAG_MODIFIERS}
          onDragStart={() => setDocumentCursor("grabbing")}
          onDragEnd={(event) => {
            setDocumentCursor(null);
            handleDragEnd(event);
          }}
          onDragCancel={() => setDocumentCursor(null)}
          accessibility={{ announcements, screenReaderInstructions: REORDER_INSTRUCTIONS }}
        >
          <SortableContext items={rowKeys.keys} strategy={verticalListSortingStrategy}>
            <ol className="flex flex-col gap-1">
              {value.map((option, index) => {
                const key = rowKeys.keys[index];
                const name = option.label.trim() || `option ${index + 1}`;
                const issue = issues[index];
                const issueId = `${baseId}-issue-${key}`;
                const colorOpen = colorOpenFor === key;
                return (
                  <SortableOptionRow
                    key={key}
                    id={key}
                    name={name}
                    disabled={disabled}
                    reducedMotion={reducedMotion}
                    below={
                      <>
                        {colorOpen && (
                          <div
                            role="group"
                            aria-label={`Colors for ${name}`}
                            className="flex flex-wrap items-center gap-1.5 pl-[3.75rem]"
                          >
                            <SwatchButton
                              name="No color"
                              selected={!option.color}
                              onClick={() => {
                                onChange(setOptionColor(value, index, null));
                                setColorOpenFor(null);
                              }}
                            />
                            {OPTION_COLOR_PRESETS.map((preset) => (
                              <SwatchButton
                                key={preset.value}
                                name={preset.name}
                                color={preset.value}
                                selected={option.color?.toLowerCase() === preset.value}
                                onClick={() => {
                                  onChange(setOptionColor(value, index, preset.value));
                                  setColorOpenFor(null);
                                }}
                              />
                            ))}
                          </div>
                        )}
                        {issue && (
                          <p id={issueId} className="pl-[3.75rem] text-xs text-destructive">
                            {issue}
                          </p>
                        )}
                      </>
                    }
                  >
                    <button
                      type="button"
                      onClick={() => setColorOpenFor(colorOpen ? null : key)}
                      disabled={disabled}
                      aria-label={`Color for ${name}`}
                      aria-expanded={colorOpen}
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "size-3.5 rounded-full",
                          option.color ? "" : "border border-dashed border-muted-foreground/60"
                        )}
                        style={option.color ? { backgroundColor: option.color } : undefined}
                      />
                    </button>
                    <Input
                      ref={(node) => {
                        if (node) inputRefs.current.set(key, node);
                        else inputRefs.current.delete(key);
                      }}
                      aria-label={`Option ${index + 1} label`}
                      aria-invalid={issue ? true : undefined}
                      aria-describedby={issue ? issueId : undefined}
                      value={option.label}
                      disabled={disabled}
                      onChange={(event) => onChange(renameOption(value, index, event.target.value))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          // Committing a rename should not submit the form mid-edit.
                          event.preventDefault();
                        } else if (event.altKey && event.key === "ArrowUp") {
                          event.preventDefault();
                          moveFromLabel(index, index - 1);
                        } else if (event.altKey && event.key === "ArrowDown") {
                          event.preventDefault();
                          moveFromLabel(index, index + 1);
                        }
                      }}
                      className="h-8"
                    />
                    <RowIconButton
                      label={`Remove ${name}`}
                      disabled={disabled}
                      onClick={() => remove(index)}
                      className="hover:text-destructive"
                    >
                      <XIcon className="size-3.5" />
                    </RowIconButton>
                  </SortableOptionRow>
                );
              })}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      <Input
        aria-label="Add option"
        aria-describedby={addHelpId}
        placeholder={value.length === 0 ? "Type an option and press Enter" : "Add option"}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          setDraft(event.target.value);
          if (addMessage) setAddMessage(null);
        }}
        onKeyDown={handleAddKeyDown}
        onPaste={handleAddPaste}
        onBlur={() => {
          // Someone who types an option and clicks Save expects it to be kept.
          if (draft.trim() && add([draft])) setDraft("");
        }}
        className="h-8"
      />
      <p
        id={addHelpId}
        aria-live="polite"
        className={cn("text-xs", addMessage ? "text-destructive" : "text-muted-foreground")}
      >
        {addMessage ?? "Press Enter to add. Paste a list (one per line) to add several at once."}
      </p>
    </div>
  );
}

const REORDER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "To reorder an option, press Space or Enter on its handle to pick it up. Use the up and down arrow keys to move it, Space or Enter to drop it, or Escape to cancel.",
};

/** Rows only ever move up and down. (@dnd-kit/modifiers is not a dependency.) */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** Keeps the dragged row inside the list rather than letting it roam the form. */
const restrictToList: Modifier = ({ transform, draggingNodeRect, containerNodeRect }) => {
  if (!draggingNodeRect || !containerNodeRect) return transform;
  const next = { ...transform };
  if (draggingNodeRect.top + next.y < containerNodeRect.top) {
    next.y = containerNodeRect.top - draggingNodeRect.top;
  } else if (draggingNodeRect.bottom + next.y > containerNodeRect.bottom) {
    next.y = containerNodeRect.bottom - draggingNodeRect.bottom;
  }
  return next;
};

const DRAG_MODIFIERS = [restrictToVerticalAxis, restrictToList];

const SORT_TRANSITION = { duration: 220, easing: "cubic-bezier(0.25, 1, 0.5, 1)" };

function SortableOptionRow({
  id,
  name,
  disabled,
  reducedMotion,
  below,
  children,
}: {
  id: string;
  name: string;
  disabled: boolean;
  reducedMotion: boolean;
  /** Content under the row (colour palette, validation message). */
  below?: React.ReactNode;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled, transition: reducedMotion ? null : SORT_TRANSITION });

  // The lifted row grows slightly; with reduced motion it only gains the
  // shadow and ring, and neighbours jump rather than glide.
  const lift = isDragging && !reducedMotion ? 1.02 : 1;
  return (
    <li
      ref={setNodeRef}
      data-option-row=""
      data-dragging={isDragging ? "" : undefined}
      style={{
        transform: CSS.Transform.toString(transform && { ...transform, scaleX: lift, scaleY: lift }),
        transition,
      }}
      className={cn(
        "relative flex flex-col gap-1 rounded-lg",
        isDragging && "z-10 bg-background shadow-lg ring-1 ring-ring/40"
      )}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${name}`}
          disabled={disabled}
          className={cn(
            "flex h-8 w-5 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40",
            isDragging ? "cursor-grabbing text-foreground" : "cursor-grab"
          )}
        >
          <GripVerticalIcon className="size-4" aria-hidden />
        </button>
        {children}
      </div>
      {below}
    </li>
  );
}

/** Keeps the grabbing cursor while the pointer wanders off the handle mid-drag. */
function setDocumentCursor(cursor: "grabbing" | null) {
  document.body.style.cursor = cursor ?? "";
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const query = window.matchMedia(REDUCED_MOTION_QUERY);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => typeof window !== "undefined" && !!window.matchMedia?.(REDUCED_MOTION_QUERY).matches,
    () => false
  );
}

function RowIconButton({
  label,
  disabled,
  onClick,
  className,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30",
        className
      )}
    >
      {children}
    </button>
  );
}

function SwatchButton({
  name,
  color,
  selected,
  onClick,
}: {
  name: string;
  color?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={name}
      aria-pressed={selected}
      title={name}
      onClick={onClick}
      className={cn(
        "flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        color ? "text-white" : "border border-dashed border-muted-foreground/60 text-muted-foreground",
        selected && "ring-2 ring-foreground/70"
      )}
      style={color ? { backgroundColor: color } : undefined}
    >
      {selected && <CheckIcon className="size-3" aria-hidden />}
    </button>
  );
}

/** Process-wide so keys stay unique across every editor instance on the page. */
let nextRowKey = 0;
const issueRowKey = () => `row-${nextRowKey++}`;

/**
 * React keys that follow each row through reorders and removals, so a row's
 * input keeps its focus and DOM identity while the list around it changes.
 * Options have no id of their own (new ones do not even have a value yet), so
 * the editor tracks one alongside the controlled list. Every edit made through
 * the editor updates both together; if the parent replaces the list with one
 * of a different length (e.g. a reset), keys are re-issued to match.
 */
function useStableRowKeys(length: number) {
  const [keys, setKeys] = useState<string[]>(() => Array.from({ length }, issueRowKey));

  let current = keys;
  if (keys.length !== length) {
    current = keys.slice(0, length);
    while (current.length < length) current.push(issueRowKey());
    // Adjusting state during render is the documented React pattern for
    // tracking a changed prop; React re-renders before committing.
    setKeys(current);
  }

  return {
    keys: current,
    move(from: number, to: number) {
      setKeys((prev) => {
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    },
    remove(index: number) {
      setKeys((prev) => prev.filter((_, i) => i !== index));
    },
    append(count: number) {
      setKeys((prev) => [...prev, ...Array.from({ length: count }, issueRowKey)]);
    },
  };
}
