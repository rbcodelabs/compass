"use client";

import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type DataGridPaginationProps = {
  /** 1-based. */
  page: number;
  pageCount: number;
  pageSize: number;
  pageSizes?: readonly number[];
  total: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  className?: string;
};

/**
 * Pagination footer.
 *
 * Boundary buttons use `aria-disabled`, **not** `disabled`, so they stay in the
 * tab order and a screen-reader user can still discover them at the ends of the
 * range. The click handler no-ops instead.
 */
function PageButton({
  label,
  icon,
  disabled,
  onClick,
  testId,
}: {
  label: string;
  icon: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      className={cn(disabled && "pointer-events-auto opacity-50")}
      onClick={() => {
        if (disabled) return;
        onClick();
      }}
    >
      {icon}
    </Button>
  );
}

export function DataGridPagination({
  page,
  pageCount,
  pageSize,
  pageSizes,
  total,
  onPageChange,
  onPageSizeChange,
  className,
}: DataGridPaginationProps) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = total === 0 ? 0 : Math.min(page * pageSize, total);
  const atStart = page <= 1;
  const atEnd = page >= pageCount;

  return (
    <nav
      aria-label="Pagination"
      data-testid="grid-pagination"
      className={cn(
        "flex flex-col gap-2 border-t border-border-default pt-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <p className="text-xs text-text-subtle" data-testid="grid-pagination-summary">
        {total === 0
          ? "No results"
          : `${first}–${last} of ${total} ${total === 1 ? "result" : "results"}`}
      </p>

      <div className="flex items-center gap-3">
        {pageSizes && pageSizes.length > 1 && onPageSizeChange && (
          <div className="flex items-center gap-1.5">
            <span
              id="grid-page-size-label"
              className="text-xs text-text-subtle"
            >
              Rows
            </span>
            <Select
              value={String(pageSize)}
              onValueChange={(next) => {
                if (typeof next === "string") onPageSizeChange(Number(next));
              }}
            >
              <SelectTrigger
                size="sm"
                aria-labelledby="grid-page-size-label"
                data-testid="grid-page-size"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <span className="text-xs text-text-subtle" data-testid="grid-page-indicator">
          Page {page} of {pageCount}
        </span>

        <div className="flex items-center gap-1">
          <PageButton
            label="First page"
            testId="grid-page-first"
            icon={<ChevronsLeft />}
            disabled={atStart}
            onClick={() => onPageChange?.(1)}
          />
          <PageButton
            label="Previous page"
            testId="grid-page-prev"
            icon={<ChevronLeft />}
            disabled={atStart}
            onClick={() => onPageChange?.(page - 1)}
          />
          <PageButton
            label="Next page"
            testId="grid-page-next"
            icon={<ChevronRight />}
            disabled={atEnd}
            onClick={() => onPageChange?.(page + 1)}
          />
          <PageButton
            label="Last page"
            testId="grid-page-last"
            icon={<ChevronsRight />}
            disabled={atEnd}
            onClick={() => onPageChange?.(pageCount)}
          />
        </div>
      </div>
    </nav>
  );
}
