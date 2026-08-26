"use client";

import { ArrowDown, ArrowUp, Columns3, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ColumnOption = {
  id: string;
  label: string;
  visible: boolean;
  /** `false` pins the column: no hiding, no reordering. */
  hideable: boolean;
};

export type ColumnOptionsMenuProps = {
  columns: readonly ColumnOption[];
  onToggle: (id: string, visible: boolean) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onReset: () => void;
};

/**
 * Show/hide and reorder columns.
 *
 * The "Move up"/"Move down" items are the accessible fallback for pointer
 * drag-reordering: everything achievable by dragging a header is achievable
 * here from the keyboard.
 */
export function ColumnOptionsMenu({
  columns,
  onToggle,
  onMove,
  onReset,
}: ColumnOptionsMenuProps) {
  const movable = columns.filter((column) => column.hideable);
  const hiddenCount = columns.filter((column) => !column.visible).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" aria-label="Columns" />}
      >
        <Columns3 />
        Columns
        {hiddenCount > 0 && (
          <span className="ml-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
            {hiddenCount}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {/* base-ui requires GroupLabel to live inside a Menu.Group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Columns</DropdownMenuLabel>
          {columns.map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={column.visible}
              disabled={!column.hideable}
              data-testid={`grid-column-toggle-${column.id}`}
              onCheckedChange={(checked) => onToggle(column.id, Boolean(checked))}
            >
              {column.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>

        {movable.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Reorder columns</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                {movable.map((column, index) => (
                  <DropdownMenuSub key={column.id}>
                    <DropdownMenuSubTrigger>{column.label}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-40">
                      <DropdownMenuItem
                        disabled={index === 0}
                        data-testid={`grid-column-move-up-${column.id}`}
                        onClick={() => onMove(column.id, -1)}
                      >
                        <ArrowUp />
                        Move up
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === movable.length - 1}
                        data-testid={`grid-column-move-down-${column.id}`}
                        onClick={() => onMove(column.id, 1)}
                      >
                        <ArrowDown />
                        Move down
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="grid-column-reset" onClick={onReset}>
          <RotateCcw />
          Reset columns
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
