"use client";

import { useState, useRef, useCallback } from "react";
import { ChevronDown, ChevronRight, Plus, X, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import { updateDocMetadata } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";

// ── types ─────────────────────────────────────────────────────────────────────

export type DocMetadata = Record<string, unknown>;

interface DocPropertiesProps {
  docId: string;
  initialMetadata: DocMetadata | null;
  revalidatePathStr: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isTagArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === "string")
  );
}

function formatDate(value: unknown): string {
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === "string") {
    // ISO date like 2026-06-27 or full ISO string
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toLocaleDateString();
  }
  return String(value);
}

function looksLikeDate(key: string, value: unknown): boolean {
  if (typeof value !== "string" && !(value instanceof Date)) return false;
  if (/date|created|updated|modified|at$/i.test(key)) return true;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return true;
  return false;
}

// ── sub-components ────────────────────────────────────────────────────────────

function TagChips({
  tags,
  onRemove,
  onAdd,
}: {
  tags: string[];
  onRemove: (tag: string) => void;
  onAdd: (tag: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");

  function commit() {
    const trimmed = input.trim();
    if (trimmed && !tags.includes(trimmed)) onAdd(trimmed);
    setInput("");
    setAdding(false);
  }

  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-xs font-medium"
        >
          <Tag className="w-2.5 h-2.5" />
          {tag}
          <button
            onClick={() => onRemove(tag)}
            className="hover:text-indigo-900 transition-colors ml-0.5"
            aria-label={`Remove ${tag}`}
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
            if (e.key === "Escape") { setAdding(false); setInput(""); }
          }}
          onBlur={commit}
          placeholder="tag name…"
          className="text-xs px-2 py-0.5 rounded border border-indigo-300 outline-none focus:ring-1 focus:ring-indigo-400 w-24"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="text-xs text-text-subtle hover:text-text-secondary flex items-center gap-0.5 transition-colors"
        >
          <Plus className="w-3 h-3" /> tag
        </button>
      )}
    </div>
  );
}

function PropertyRow({
  propKey,
  value,
  onChangeValue,
  onChangeKey,
  onDelete,
}: {
  propKey: string;
  value: unknown;
  onChangeValue: (val: unknown) => void;
  onChangeKey: (newKey: string) => void;
  onDelete: () => void;
}) {
  const [editingKey, setEditingKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState(propKey);

  if (isTagArray(value)) {
    return (
      <div className="flex gap-3 items-start py-1.5 group/row">
        <div className="w-28 shrink-0 flex items-center gap-1 pt-0.5">
          {editingKey ? (
            <input
              autoFocus
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { onChangeKey(keyDraft); setEditingKey(false); }
                if (e.key === "Escape") { setKeyDraft(propKey); setEditingKey(false); }
              }}
              onBlur={() => { onChangeKey(keyDraft); setEditingKey(false); }}
              className="text-xs font-medium text-text-subtle bg-transparent border-b border-border-strong outline-none w-full"
            />
          ) : (
            <button
              onClick={() => setEditingKey(true)}
              className="text-xs font-medium text-text-subtle hover:text-text-secondary truncate text-left"
            >
              {propKey}
            </button>
          )}
        </div>
        <div className="flex-1">
          <TagChips
            tags={value}
            onRemove={(tag) => onChangeValue(value.filter((t) => t !== tag))}
            onAdd={(tag) => onChangeValue([...value, tag])}
          />
        </div>
        <button
          onClick={onDelete}
          className="opacity-0 group-hover/row:opacity-100 transition-opacity text-slate-300 hover:text-red-400 pt-0.5"
          aria-label="Delete property"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  const isDate = looksLikeDate(propKey, value);

  return (
    <div className="flex gap-3 items-center py-1.5 group/row">
      <div className="w-28 shrink-0">
        {editingKey ? (
          <input
            autoFocus
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onChangeKey(keyDraft); setEditingKey(false); }
              if (e.key === "Escape") { setKeyDraft(propKey); setEditingKey(false); }
            }}
            onBlur={() => { onChangeKey(keyDraft); setEditingKey(false); }}
            className="text-xs font-medium text-text-subtle bg-transparent border-b border-border-strong outline-none w-full"
          />
        ) : (
          <button
            onClick={() => setEditingKey(true)}
            className="text-xs font-medium text-text-subtle hover:text-text-secondary truncate text-left w-full"
          >
            {propKey}
          </button>
        )}
      </div>
      <div className="flex-1">
        {isDate ? (
          <input
            type="date"
            defaultValue={typeof value === "string" ? value.slice(0, 10) : ""}
            onChange={(e) => onChangeValue(e.target.value)}
            className="text-xs text-text-secondary bg-transparent border-b border-transparent hover:border-border-default focus:border-indigo-300 outline-none"
          />
        ) : (
          <input
            type="text"
            defaultValue={String(value ?? "")}
            onBlur={(e) => onChangeValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="text-xs text-text-secondary bg-transparent border-b border-transparent hover:border-border-default focus:border-indigo-300 outline-none w-full"
          />
        )}
      </div>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover/row:opacity-100 transition-opacity text-slate-300 hover:text-red-400"
        aria-label="Delete property"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export function DocProperties({
  docId,
  initialMetadata,
  revalidatePathStr,
}: DocPropertiesProps) {
  const [open, setOpen] = useState(
    initialMetadata !== null && Object.keys(initialMetadata).length > 0
  );
  const [metadata, setMetadata] = useState<DocMetadata>(initialMetadata ?? {});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(
    (next: DocMetadata) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        updateDocMetadata(docId, next, revalidatePathStr).catch(console.error);
      }, 800);
    },
    [docId, revalidatePathStr]
  );

  function update(next: DocMetadata) {
    setMetadata(next);
    persist(next);
  }

  function handleChangeValue(key: string, val: unknown) {
    update({ ...metadata, [key]: val });
  }

  function handleChangeKey(oldKey: string, newKey: string) {
    if (oldKey === newKey || !newKey.trim()) return;
    const next: DocMetadata = {};
    for (const [k, v] of Object.entries(metadata)) {
      next[k === oldKey ? newKey.trim() : k] = v;
    }
    update(next);
  }

  function handleDelete(key: string) {
    const next = { ...metadata };
    delete next[key];
    update(next);
  }

  function handleAddProperty() {
    const key = `property_${Date.now()}`;
    update({ ...metadata, [key]: "" });
  }

  const hasProperties = Object.keys(metadata).length > 0;

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium text-text-subtle hover:text-text-secondary transition-colors",
          hasProperties && "text-text-subtle"
        )}
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        Properties
        {hasProperties && !open && (
          <span className="text-slate-300 font-normal">
            ({Object.keys(metadata).length})
          </span>
        )}
      </button>

      {open && (
        <div className="mt-2 ml-0.5">
          {Object.entries(metadata).map(([key, value]) => (
            <PropertyRow
              key={key}
              propKey={key}
              value={value}
              onChangeValue={(val) => handleChangeValue(key, val)}
              onChangeKey={(newKey) => handleChangeKey(key, newKey)}
              onDelete={() => handleDelete(key)}
            />
          ))}
          <button
            onClick={handleAddProperty}
            className="mt-1 flex items-center gap-1 text-xs text-text-subtle hover:text-text-secondary transition-colors"
          >
            <Plus className="w-3 h-3" /> Add property
          </button>
        </div>
      )}
    </div>
  );
}
