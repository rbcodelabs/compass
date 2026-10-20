"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { StatusBadge } from "@/components/patterns"
import { MarkdownContent } from "@/components/markdown-content"
import { MarkdownDescriptionEditor } from "@/components/markdown-description-editor"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { optionsWithCurrent, type EnumOption } from "@/lib/spec-canvas/options"
import type { SpecTone } from "@/lib/spec-canvas/shape"
import type { SaveResult } from "./use-spec-editor"
import { cn } from "@/lib/utils"

/** How long typing must pause before an edit is autosaved; blur and Enter save immediately. */
export const AUTOSAVE_DELAY_MS = 800

/**
 * Click-to-edit single-line text with autosave. The display is a real button,
 * so Enter/Space on it starts editing. While editing: typing autosaves after a
 * pause, Enter or blur saves now, Escape abandons the draft. An empty value is
 * never sent when `required`; the previous text is kept instead.
 */
export function InlineText({
  value, onSave, label, className, inputClassName, required = true, readOnly = false, placeholder = "Add…", children,
}: {
  value: string
  onSave: (next: string) => Promise<SaveResult>
  label: string
  className?: string
  inputClassName?: string
  required?: boolean
  readOnly?: boolean
  placeholder?: string
  children?: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSent = useRef(value)
  const cancelled = useRef(false)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  async function flush(next: string) {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (required && !next.trim()) return
    if (next.trim() === lastSent.current.trim()) return
    lastSent.current = next
    const result = await onSave(next)
    if (!result.ok) { lastSent.current = value; setError(result.error) } else setError(null)
  }

  if (readOnly) return <span className={className}>{children ?? (value || placeholder)}</span>

  if (!editing) {
    return (
      <span className="block min-w-0">
        <button
          type="button"
          aria-label={`Edit ${label}`}
          onClick={() => { lastSent.current = value; cancelled.current = false; setDraft(value); setError(null); setEditing(true) }}
          className={cn("-mx-1 block max-w-full cursor-text rounded px-1 text-left hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-ring", !value && "text-text-subtle italic", className)}
        >
          {children ?? (value || placeholder)}
        </button>
        {error && <span role="alert" className="block text-xs text-status-danger">{error}</span>}
      </span>
    )
  }

  return (
    <span className="block min-w-0">
      <input
        autoFocus
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => void flush(next), AUTOSAVE_DELAY_MS)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void flush(draft); setEditing(false) }
          if (event.key === "Escape") {
            cancelled.current = true
            if (timer.current) { clearTimeout(timer.current); timer.current = null }
            // An autosave may already have gone out; restore whatever was last on screen before editing.
            if (lastSent.current.trim() !== value.trim()) void onSave(value)
            setEditing(false)
          }
        }}
        onBlur={() => { if (!cancelled.current) void flush(draft); setEditing(false) }}
        className={cn("w-full rounded-md border border-border-interactive bg-surface-base px-2 py-1 text-text-primary focus:outline-none focus:ring-2 focus:ring-ring", className, inputClassName)}
      />
      {error && <span role="alert" className="block text-xs text-status-danger">{error}</span>}
    </span>
  )
}

/**
 * Click-to-edit markdown (the same editor the opportunity page uses). Autosaves
 * on a typing pause and when focus leaves the editor; saving never closes the
 * editor mid-typing, leaving it does.
 */
export function InlineMarkdown({
  value, onSave, label, placeholder, readOnly = false, className,
}: {
  value: string | null
  onSave: (next: string | null) => Promise<SaveResult>
  label: string
  placeholder: string
  readOnly?: boolean
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? "")
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSent = useRef((value ?? "").trim())

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  async function flush(next: string) {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const trimmed = next.trim()
    if (trimmed === lastSent.current) return
    const before = lastSent.current
    lastSent.current = trimmed
    const result = await onSave(trimmed || null)
    if (!result.ok) { lastSent.current = before; setError(result.error) } else setError(null)
  }

  if (readOnly && !value?.trim()) return null

  if (readOnly) return <div className={cn("min-w-0", className)}><MarkdownContent>{value ?? ""}</MarkdownContent></div>

  if (!editing) {
    return (
      <div className={cn("min-w-0", className)}>
        <button
          type="button"
          aria-label={`Edit ${label}`}
          onClick={() => { setDraft(value ?? ""); lastSent.current = (value ?? "").trim(); setError(null); setEditing(true) }}
          className="-mx-1 block w-full cursor-text rounded px-1 text-left hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-ring"
        >
          {value?.trim() ? <MarkdownContent>{value}</MarkdownContent> : <span className="text-sm italic text-text-subtle">{placeholder}</span>}
        </button>
        {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
      </div>
    )
  }

  return (
    <div
      className={cn("min-w-0", className)}
      onBlur={(event) => {
        // Focus moving between the editor's own toolbar and body is not "leaving".
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        void flush(draft)
        setEditing(false)
      }}
    >
      <MarkdownDescriptionEditor
        value={draft}
        label={label}
        placeholder={placeholder}
        onChange={(next) => {
          setDraft(next)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => void flush(next), AUTOSAVE_DELAY_MS * 1.5)
        }}
      />
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
    </div>
  )
}

/** A StatusBadge that opens a menu of choices and saves the pick. */
export function EnumPicker({
  value, options, tone, label, onPick, suffix, readOnly = false,
}: {
  value: string
  options: readonly EnumOption[]
  tone: SpecTone
  label: string
  onPick: (next: string) => Promise<SaveResult>
  suffix?: string
  readOnly?: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const all = optionsWithCurrent(options, value)
  const current = all.find((o) => o.value === value)?.label ?? value
  const badge = <StatusBadge status={tone}>{current}{suffix ? ` ${suffix}` : ""}</StatusBadge>
  if (readOnly) return badge
  return (
    <span className="inline-flex flex-col items-end">
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={`${label}: ${current}. Change`} className="cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-ring">
          {badge}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={async (next: string) => {
              if (next === value) return
              const result = await onPick(next)
              setError(result.ok ? null : result.error)
            }}
          >
            {all.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value}>{option.label}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <span role="alert" className="text-xs text-status-danger">{error}</span>}
    </span>
  )
}

/**
 * "+ Add …" row. Opens an input; Enter creates and keeps the input open and
 * focused for the next one (keyboard-first), Escape or blur-while-empty closes.
 */
export function AddItem({
  label, placeholder, open, onOpenChange, onCreate, className,
}: {
  label: string
  placeholder: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (title: string) => Promise<SaveResult>
  className?: string
}) {
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  async function submit() {
    if (busy) return
    if (!draft.trim()) return
    setBusy(true)
    const result = await onCreate(draft)
    setBusy(false)
    if (result.ok) { setDraft(""); setError(null); input.current?.focus() } else setError(result.error)
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className={cn("flex w-full items-center gap-2 rounded-lg border border-dashed border-border-default px-3 py-2 text-left text-sm text-text-subtle hover:border-border-strong hover:text-text-primary focus-visible:outline-2 focus-visible:outline-ring", className)}
      >
        <span aria-hidden>+</span> {label}
      </button>
    )
  }
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <input
        ref={input}
        autoFocus
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        disabled={busy}
        onChange={(event) => { setDraft(event.target.value); setError(null) }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void submit() }
          if (event.key === "Escape") { setDraft(""); setError(null); onOpenChange(false) }
        }}
        onBlur={() => { if (!draft.trim() && !busy) { setError(null); onOpenChange(false) } }}
        className="w-full rounded-lg border border-border-interactive bg-surface-base px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <p className="text-xs text-text-subtle">Enter to add and keep going, Escape to finish.</p>
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
    </div>
  )
}
