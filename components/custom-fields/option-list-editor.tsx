"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, XIcon } from "lucide-react";
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

  const issues = optionListIssues(value);

  useEffect(() => {
    if (!pendingFocus.current) return;
    inputRefs.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  function move(from: number, to: number) {
    if (to < 0 || to >= value.length) return;
    // Keep the caret with the row that moved, so repeated Alt+Arrow keeps moving it.
    pendingFocus.current = rowKeys.keys[from];
    rowKeys.move(from, to);
    onChange(moveOption(value, from, to));
  }

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
        <ol className="flex flex-col gap-1">
          {value.map((option, index) => {
            const key = rowKeys.keys[index];
            const name = option.label.trim() || `option ${index + 1}`;
            const issue = issues[index];
            const issueId = `${baseId}-issue-${key}`;
            const colorOpen = colorOpenFor === key;
            return (
              <li key={key} className="flex flex-col gap-1">
                <div className="flex items-center gap-1">
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
                        move(index, index - 1);
                      } else if (event.altKey && event.key === "ArrowDown") {
                        event.preventDefault();
                        move(index, index + 1);
                      }
                    }}
                    className="h-8"
                  />
                  <RowIconButton
                    label={`Move ${name} up`}
                    disabled={disabled || index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </RowIconButton>
                  <RowIconButton
                    label={`Move ${name} down`}
                    disabled={disabled || index === value.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </RowIconButton>
                  <RowIconButton
                    label={`Remove ${name}`}
                    disabled={disabled}
                    onClick={() => remove(index)}
                    className="hover:text-destructive"
                  >
                    <XIcon className="size-3.5" />
                  </RowIconButton>
                </div>

                {colorOpen && (
                  <div
                    role="group"
                    aria-label={`Colors for ${name}`}
                    className="ml-9 flex flex-wrap items-center gap-1.5"
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
                  <p id={issueId} className="ml-9 text-xs text-destructive">
                    {issue}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
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
