"use client";

import { ListFilter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
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

type FacetedFilterSingleGroup = {
  id: string;
  label: string;
  values?: never;
  onValuesChange?: never;
  value?: string | null;
  options: FacetedFilterOption[];
  onValueChange: (value: string | null) => void;
};

type FacetedFilterMultiGroup = {
  id: string;
  label: string;
  value?: never;
  onValueChange?: never;
  values: readonly string[];
  options: FacetedFilterOption[];
  onValuesChange: (values: string[]) => void;
};

export type FacetedFilterGroup = FacetedFilterSingleGroup | FacetedFilterMultiGroup;

function isMultiGroup(group: FacetedFilterGroup): group is FacetedFilterMultiGroup {
  return Array.isArray(group.values);
}

type FacetedFilterMenuProps = {
  groups: FacetedFilterGroup[];
  onClearAll: () => void;
};

export function FacetedFilterMenu({ groups, onClearAll }: FacetedFilterMenuProps) {
  const activeCount = groups.filter((group) =>
    isMultiGroup(group)
      ? group.values.length < group.options.length
      : Boolean(group.value),
  ).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" aria-label="Filters" />
        }
      >
        <ListFilter />
        Filters
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
            {isMultiGroup(group) ? (
              group.options.map((option) => {
                const checked = group.values.includes(option.value);
                return (
                  <DropdownMenuCheckboxItem
                    key={option.value}
                    checked={checked}
                    closeOnClick={false}
                    disabled={checked && group.values.length === 1}
                    onCheckedChange={(nextChecked) => {
                      const values = nextChecked
                        ? [...group.values, option.value]
                        : group.values.filter((value) => value !== option.value);
                      group.onValuesChange(values);
                    }}
                  >
                    {option.color && (
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: option.color }}
                      />
                    )}
                    <span className="truncate">{option.label}</span>
                  </DropdownMenuCheckboxItem>
                );
              })
            ) : (
              <DropdownMenuRadioGroup
                value={group.value ?? ""}
                onValueChange={(value) => group.onValueChange(value || null)}
              >
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
            )}
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
