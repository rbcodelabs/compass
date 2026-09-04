"use client";

import { ListFilter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

export type FacetedFilterOption = {
  value: string;
  label: string;
  color?: string | null;
};

export type FacetedFilterGroup = {
  id: string;
  label: string;
  value?: string | null;
  options: FacetedFilterOption[];
  onValueChange: (value: string | null) => void;
  allLabel?: string;
};

type FacetedFilterMenuProps = {
  groups: FacetedFilterGroup[];
  onClearAll: () => void;
  compact?: boolean;
};

export function FacetedFilterMenu({ groups, onClearAll, compact }: FacetedFilterMenuProps) {
  const activeCount = groups.filter((group) => group.value).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" aria-label="Filters" />
        }
      >
        <ListFilter />
        <span className={compact ? "hidden sm:inline" : undefined}>Filters</span>
        {activeCount > 0 && (
          <span className="ml-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
            {activeCount}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {groups.map((group, index) => (
          <DropdownMenuGroup key={group.id}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={group.value ?? (group.allLabel ? "__all__" : "")}
              onValueChange={(value) => group.onValueChange(value === "__all__" ? null : value || null)}
            >
              {group.allLabel && (
                <DropdownMenuRadioItem value="__all__">
                  {group.allLabel}
                </DropdownMenuRadioItem>
              )}
              {group.options.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.color && (
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: option.color }}
                    />
                  )}
                  <span className="truncate">{option.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        ))}
        {activeCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onClearAll}>
              Clear all
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
