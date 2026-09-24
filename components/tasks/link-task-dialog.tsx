"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { BeakerIcon, BookOpenIcon, CheckIcon, ChevronDownIcon, CircleHelpIcon, FileTextIcon, FlagIcon, LightbulbIcon, MapIcon, MessageSquareTextIcon, SearchIcon, TargetIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { linkTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import { cn } from "@/lib/utils";
import type { TaskLinkedType, TaskLinkData } from "@/lib/types";

const LINKED_TYPE_LABELS: Record<TaskLinkedType, string> = {
  OPPORTUNITY: "Opportunity", SOLUTION: "Solution", ROADMAP_ITEM: "Roadmap Item",
  OBJECTIVE: "Objective", KEY_RESULT: "Key Result", DOC: "Doc", EXPERIMENT: "Experiment",
  FEEDBACK_ITEM: "Feedback Item", DECISION: "Decision",
};
const LINKED_TYPE_PLURAL_LABELS: Record<TaskLinkedType, string> = {
  OPPORTUNITY: "Opportunities", SOLUTION: "Solutions", ROADMAP_ITEM: "Roadmap items",
  OBJECTIVE: "Objectives", KEY_RESULT: "Key results", DOC: "Docs", EXPERIMENT: "Experiments",
  FEEDBACK_ITEM: "Feedback items", DECISION: "Decisions",
};
const LINKED_TYPE_ICONS: Record<TaskLinkedType, React.ComponentType<{ className?: string; "aria-hidden"?: React.AriaAttributes["aria-hidden"] }>> = {
  OPPORTUNITY: TargetIcon, SOLUTION: LightbulbIcon, ROADMAP_ITEM: MapIcon, OBJECTIVE: FlagIcon,
  KEY_RESULT: CheckIcon, DOC: FileTextIcon, EXPERIMENT: BeakerIcon,
  FEEDBACK_ITEM: MessageSquareTextIcon, DECISION: CircleHelpIcon,
};
const LINKED_TYPES = Object.keys(LINKED_TYPE_LABELS) as TaskLinkedType[];
const PRIMARY_FILTERS: TaskLinkedType[] = ["OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "DOC"];
const SECONDARY_FILTERS = LINKED_TYPES.filter((type) => !PRIMARY_FILTERS.includes(type));
const MAX_VISIBLE_RESULTS = 75;

export type LinkableTarget = { id: string; title: string };
export type LinkableTargets = Record<TaskLinkedType, LinkableTarget[]>;
type LinkableItem = LinkableTarget & { type: TaskLinkedType; compositeId: string };
type Props = {
  taskId: string; open: boolean; onOpenChange: (open: boolean) => void;
  revalidatePathStr: string; linkableTargets: LinkableTargets; onLinked: (link: TaskLinkData) => void;
};

function flattenTargets(linkableTargets: LinkableTargets): LinkableItem[] {
  return LINKED_TYPES.flatMap((type) => (linkableTargets[type] ?? []).map((target) => ({
    ...target, type, compositeId: `${type}:${target.id}`,
  })));
}

function itemMatchesFilters(item: LinkableItem, query: string, typeFilter: TaskLinkedType | "ALL") {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return (typeFilter === "ALL" || item.type === typeFilter) &&
    (!normalizedQuery || item.title.toLocaleLowerCase().includes(normalizedQuery));
}

export function LinkTaskDialog({ taskId, open, onOpenChange, revalidatePathStr, linkableTargets, onLinked }: Props) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const allItems = useMemo(() => flattenTargets(linkableTargets), [linkableTargets]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TaskLinkedType | "ALL">("ALL");
  const [showMoreTypes, setShowMoreTypes] = useState(false);
  const [selectedCompositeId, setSelectedCompositeId] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const matchingItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filtered = allItems.filter((item) => itemMatchesFilters(item, query, typeFilter));
    if (!normalizedQuery) return filtered;
    return filtered.map((item, originalIndex) => ({ item, originalIndex })).sort((a, b) => {
      const rank = (title: string) => title === normalizedQuery ? 0 : title.startsWith(normalizedQuery) ? 1 : 2;
      return rank(a.item.title.toLocaleLowerCase()) - rank(b.item.title.toLocaleLowerCase()) || a.originalIndex - b.originalIndex;
    }).map(({ item }) => item);
  }, [allItems, query, typeFilter]);

  const visibleItems = matchingItems.slice(0, MAX_VISIBLE_RESULTS);
  const selectedItem = allItems.find((item) => item.compositeId === selectedCompositeId) ?? null;
  const activeSecondaryFilter = typeFilter !== "ALL" && SECONDARY_FILTERS.includes(typeFilter) ? typeFilter : null;
  const resultLabel = `${matchingItems.length} ${query.trim() ? `result${matchingItems.length === 1 ? "" : "s"}` : `item${matchingItems.length === 1 ? "" : "s"}`}`;

  useEffect(() => {
    const item = visibleItems[activeIndex];
    if (item) document.getElementById(`${listboxId}-${item.compositeId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listboxId, visibleItems]);

  function resetState() {
    setQuery(""); setTypeFilter("ALL"); setShowMoreTypes(false);
    setSelectedCompositeId(null); setActiveIndex(0); setError(null);
  }
  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && isPending) return;
    if (!nextOpen && !isPending) resetState();
    onOpenChange(nextOpen);
  }
  function selectType(nextType: TaskLinkedType | "ALL") {
    setTypeFilter(nextType); setActiveIndex(0); setError(null);
    if (selectedItem && !itemMatchesFilters(selectedItem, query, nextType)) setSelectedCompositeId(null);
  }
  function selectItem(item: LinkableItem) {
    setSelectedCompositeId(item.compositeId); setError(null);
  }
  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { event.preventDefault(); handleOpenChange(false); return; }
    if (!visibleItems.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => (index + 1) % visibleItems.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => (index - 1 + visibleItems.length) % visibleItems.length); }
    else if (event.key === "Enter") { event.preventDefault(); selectItem(visibleItems[activeIndex]); }
  }
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedItem || isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        const link = await linkTask(taskId, selectedItem.type, selectedItem.id, revalidatePathStr);
        onLinked({ id: link.id, linkedType: selectedItem.type, linkedId: selectedItem.id, linkedTitle: selectedItem.title });
        resetState();
        onOpenChange(false);
      } catch {
        setError("Could not link this item. Please try again.");
      }
    });
  }
  function renderFilter(type: TaskLinkedType) {
    const Icon = LINKED_TYPE_ICONS[type];
    return <Button key={type} type="button" variant={typeFilter === type ? "secondary" : "outline"} size="xs"
      aria-pressed={typeFilter === type} disabled={isPending} onClick={() => selectType(type)} className="rounded-full">
      <Icon aria-hidden="true" />{LINKED_TYPE_PLURAL_LABELS[type]}
    </Button>;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[min(44rem,calc(100dvh-1.5rem))] max-w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl" initialFocus={inputRef}>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="gap-1 px-5 pt-5 pr-14 pb-4 sm:px-6 sm:pt-6 sm:pr-16">
            <DialogTitle className="text-xl">Link to another item</DialogTitle>
            <DialogDescription>Find anything available to link in this workspace.</DialogDescription>
          </DialogHeader>
          <div className="border-b px-5 pb-4 sm:px-6">
            <div className="flex h-11 items-center gap-3 rounded-xl border border-input bg-background px-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input ref={inputRef} role="combobox" aria-label="Search linkable items" aria-controls={listboxId} aria-expanded={open}
                aria-activedescendant={visibleItems.length ? `${listboxId}-${visibleItems[activeIndex]?.compositeId}` : undefined}
                autoComplete="off" value={query} disabled={isPending}
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  setQuery(nextQuery); setActiveIndex(0); setError(null);
                  if (selectedItem && !itemMatchesFilters(selectedItem, nextQuery, typeFilter)) setSelectedCompositeId(null);
                }}
                onKeyDown={handleInputKeyDown} placeholder="Search opportunities, docs, roadmap, and more…"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed" />
              <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:block">ESC</kbd>
            </div>
            <div aria-label="Filter by item type" className="mt-3 flex gap-2 overflow-x-auto pb-1">
              <Button type="button" variant={typeFilter === "ALL" ? "secondary" : "outline"} size="xs" aria-label="All item types"
                aria-pressed={typeFilter === "ALL"} disabled={isPending} onClick={() => selectType("ALL")} className="rounded-full">All</Button>
              {PRIMARY_FILTERS.map(renderFilter)}
              <Button type="button" variant={activeSecondaryFilter ? "secondary" : "outline"} size="xs"
                aria-label={!showMoreTypes && activeSecondaryFilter ? `More types, ${LINKED_TYPE_PLURAL_LABELS[activeSecondaryFilter]} active` : "More types"}
                aria-pressed={Boolean(activeSecondaryFilter)} aria-expanded={showMoreTypes} disabled={isPending}
                onClick={() => setShowMoreTypes((shown) => !shown)} className="rounded-full">More
                <ChevronDownIcon className={cn("transition-transform", showMoreTypes && "rotate-180")} aria-hidden="true" />
              </Button>
            </div>
            {showMoreTypes && <div className="mt-2 flex flex-wrap gap-2">{SECONDARY_FILTERS.map(renderFilter)}</div>}
          </div>
          <div className="grid min-h-0 flex-1 sm:grid-cols-[minmax(0,1.5fr)_minmax(16rem,0.85fr)]">
            <section className="flex min-h-0 flex-col border-border sm:border-r" aria-label="Linkable items">
              <div className="flex items-center justify-between px-5 py-3 text-xs font-medium text-muted-foreground">
                <span>{query.trim() ? "Best matches" : "Available items"}</span>
                <span>{matchingItems.length > MAX_VISIBLE_RESULTS ? `Showing ${MAX_VISIBLE_RESULTS} of ${matchingItems.length}` : resultLabel}</span>
              </div>
              <div id={listboxId} role="listbox" aria-label="Linkable item results" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 sm:px-4">
                {visibleItems.map((item, index) => {
                  const Icon = LINKED_TYPE_ICONS[item.type];
                  const selected = selectedCompositeId === item.compositeId;
                  return <button key={item.compositeId} id={`${listboxId}-${item.compositeId}`} type="button" role="option"
                    aria-label={`${item.title} ${LINKED_TYPE_LABELS[item.type]}`} aria-selected={selected}
                    disabled={isPending} onMouseMove={() => setActiveIndex(index)} onClick={() => selectItem(item)}
                    className={cn("mb-1 flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50", activeIndex === index && "bg-accent", selected && "bg-primary/10 ring-1 ring-primary/20")}>
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" aria-hidden="true" /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{LINKED_TYPE_LABELS[item.type]}</span></span>
                    {selected && <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />}
                  </button>;
                })}
                {allItems.length === 0 && <div className="grid min-h-48 place-content-center px-4 text-center text-sm text-muted-foreground"><BookOpenIcon className="mx-auto mb-3 size-8" aria-hidden="true" /><p>No items available to link in this workspace.</p></div>}
                {allItems.length > 0 && matchingItems.length === 0 && <div className="grid min-h-48 place-content-center px-4 text-center"><SearchIcon className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden="true" /><p className="font-medium">No matches found</p><p className="mt-1 text-sm text-muted-foreground">Try a different phrase or item type.</p><Button type="button" variant="link" size="sm" onClick={() => { setQuery(""); selectType("ALL"); inputRef.current?.focus(); }}>Clear search</Button></div>}
              </div>
            </section>
            <aside aria-label="Selected item preview" aria-live="polite" className="hidden min-h-0 bg-muted/30 p-6 sm:flex sm:flex-col">
              {selectedItem ? <div><div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">{(() => { const Icon = LINKED_TYPE_ICONS[selectedItem.type]; return <Icon className="size-3.5" aria-hidden="true" />; })()}{LINKED_TYPE_LABELS[selectedItem.type]}</div><h3 className="mt-4 text-lg font-semibold leading-snug">{selectedItem.title}</h3><p className="mt-3 text-sm leading-relaxed text-muted-foreground">This item is in the current workspace and will appear in this task&apos;s Links section.</p><div className="mt-6 rounded-xl border bg-background p-3 text-sm"><p className="text-xs font-medium text-muted-foreground">Link context</p><p className="mt-1">Task → {LINKED_TYPE_LABELS[selectedItem.type]}</p></div></div>
                : <div className="m-auto text-center"><div className="mx-auto grid size-11 place-items-center rounded-xl border bg-background text-muted-foreground"><SearchIcon className="size-5" aria-hidden="true" /></div><h3 className="mt-3 font-medium">Select an item</h3><p className="mt-1 max-w-48 text-sm text-muted-foreground">Choose a result to review its linking context.</p></div>}
            </aside>
          </div>
          {error && <p role="alert" className="border-t border-destructive/20 bg-destructive/10 px-5 py-2 text-sm text-destructive sm:px-6">{error}</p>}
          {isPending && <span role="status" className="sr-only">Linking item</span>}
          <div aria-live="polite" className="sr-only">{resultLabel}</div>
          <DialogFooter className="mx-0 mb-0 shrink-0 flex-row items-center justify-end rounded-none bg-background px-5 py-3 sm:px-6">
            <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => handleOpenChange(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={isPending || !selectedItem}>{isPending ? "Linking…" : "Link item"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
