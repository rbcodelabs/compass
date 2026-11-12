"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type GallerySectionGroup<T> = { key: string; label: string; color: string | null; items: T[] };

/**
 * The collapsible grouped grid shared by the Roadmap and Experiments Galleries. `groupMode` namespaces
 * the collapsed state and the element ids; "none" renders one ungrouped grid with no header.
 */
export function GalleryGroupSections<T>({ groups, groupMode, testId, renderItem }: {
  groups: GallerySectionGroup<T>[];
  groupMode: string;
  testId: string;
  renderItem: (item: T) => React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <div className="flex flex-col gap-8 p-4 md:p-7" data-testid={testId}>
      {groups.map((group) => {
        const closed = collapsed[`${groupMode}:${group.key}`] ?? false;
        const gridId = `gallery-group-${groupMode}-${group.key}`;
        return (
          <section key={group.key} aria-label={group.label}>
            {groupMode !== "none" && (
              <button
                type="button"
                aria-expanded={!closed}
                aria-controls={gridId}
                onClick={() => setCollapsed((prev) => ({ ...prev, [`${groupMode}:${group.key}`]: !closed }))}
                className="mb-3 flex items-center gap-2 text-sm font-semibold"
              >
                <ChevronDown aria-hidden="true" className={cn("size-4 text-text-subtle transition-transform", closed && "-rotate-90")} />
                {group.color && <span aria-hidden="true" className="size-2.5 rounded-full" style={{ backgroundColor: group.color }} />}
                <h2>{group.label}</h2>
                <span className="rounded-full bg-surface-inset px-2 py-0.5 text-xs font-normal text-text-subtle">{group.items.length}</span>
              </button>
            )}
            {/* The padding gives the cards' shadows room, so the scroll container never clips them. */}
            <div id={gridId} hidden={closed} className="grid grid-cols-1 gap-7 px-0.5 pb-2 md:grid-cols-2 xl:grid-cols-3">
              {group.items.map((item) => renderItem(item))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
