"use client";

import { Children, useId, useState, type ComponentProps, type ReactNode } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Shared controls for the workspace header's `actions` slot. See
 * docs/design/workspace-header.md for the slot order these are built for:
 * View → Arrange → Filter → Primary action → More (⋯).
 */

/**
 * Icon-only outline button: 44px below `md` (touch target), 32px from `md`, the
 * same height as every other header control (see HEADER_CONTROL_SIZE in workspace-page.tsx).
 */
const ICON_BUTTON_CLASS = "size-11 md:size-8";

type WorkspaceIconButtonProps = {
  /** Accessible name and tooltip text. */
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Tooltip shown instead of `label` while disabled. */
  disabledReason?: string;
  /** Accessible name of the focusable wrapper a disabled button needs so the reason stays reachable. */
  disabledLabel?: string;
  className?: string;
};

export function WorkspaceIconButton({
  label,
  children,
  onClick,
  disabled = false,
  disabledReason,
  disabledLabel,
  className,
}: WorkspaceIconButtonProps) {
  const tooltipId = useId();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const describedBy = tooltipOpen ? tooltipId : undefined;
  return (
    <TooltipProvider>
      <Tooltip onOpenChange={setTooltipOpen}>
        {disabled ? (
          <TooltipTrigger
            aria-describedby={describedBy}
            render={<span className="inline-flex" tabIndex={0} aria-label={disabledLabel ?? `${label} (unavailable)`} />}
          >
            <Button type="button" variant="outline" size="icon" className={cn(ICON_BUTTON_CLASS, className)} aria-label={label} disabled>
              {children}
            </Button>
          </TooltipTrigger>
        ) : (
          <TooltipTrigger
            aria-describedby={describedBy}
            render={<Button type="button" variant="outline" size="icon" className={cn(ICON_BUTTON_CLASS, className)} aria-label={label} onClick={onClick} />}
          >
            {children}
          </TooltipTrigger>
        )}
        <TooltipContent id={tooltipId} role="tooltip" side="bottom">
          {disabled ? (disabledReason ?? label) : label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type WorkspaceMoreMenuProps = {
  /** Menu groups: `DropdownMenuGroup` / `DropdownMenuItem` / radio and checkbox items. */
  children?: ReactNode;
  /** Accessible name for the trigger and the menu. */
  label?: string;
  /** Shows a dot on the trigger when something inside the menu is non-default. */
  active?: boolean;
  className?: string;
};

/**
 * The rightmost header control: an overflow menu for low-frequency, page-level
 * actions. The pattern owns the trigger, tooltip and sizing; the page owns the
 * menu content. Renders nothing when it has no content, so a page never shows
 * an empty ⋯.
 */
export function WorkspaceMoreMenu({ children, label = "More actions", active = false, className }: WorkspaceMoreMenuProps) {
  const tooltipId = useId();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  if (Children.toArray(children).length === 0) return null;
  return (
    <TooltipProvider>
      <DropdownMenu>
        <Tooltip onOpenChange={setTooltipOpen}>
          <TooltipTrigger
            aria-describedby={tooltipOpen ? tooltipId : undefined}
            render={
              <DropdownMenuTrigger
                render={<Button variant="outline" size="icon" aria-label={label} className={cn("relative", ICON_BUTTON_CLASS, className)} />}
              />
            }
          >
            <MoreHorizontal />
            {active && <span aria-hidden="true" data-slot="workspace-more-menu-dot" className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />}
          </TooltipTrigger>
          <TooltipContent id={tooltipId} role="tooltip" side="bottom">{label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          aria-label={label}
          className="w-56 max-w-[calc(100vw-24px)] [&_[role=menuitem]]:min-h-11 [&_[role=menuitemcheckbox]]:min-h-11 [&_[role=menuitemradio]]:min-h-11 md:[&_[role=menuitem]]:min-h-0 md:[&_[role=menuitemcheckbox]]:min-h-0 md:[&_[role=menuitemradio]]:min-h-0"
        >
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

type WorkspaceCreateButtonProps = Omit<ComponentProps<typeof Button>, "variant" | "size" | "children"> & {
  /** What the button creates, e.g. "New task". Becomes the accessible name. */
  label: string;
};

/**
 * The header's single primary action. The label collapses to the icon below
 * `sm` (the accessible name is kept) so it never squeezes the page title.
 */
export function WorkspaceCreateButton({ label, className, ...props }: WorkspaceCreateButtonProps) {
  return (
    <Button type="button" size="sm" aria-label={label} className={className} {...props}>
      <Plus />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

type WorkspaceViewOption = {
  value: string;
  /** Accessible name and tooltip text, e.g. "Board". */
  label: string;
  icon: ReactNode;
};

type WorkspaceViewSwitcherProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: WorkspaceViewOption[];
  /** Accessible name of the tab list. */
  label?: string;
};

/**
 * The View slot: an icon-only segmented switcher (board / list / table /
 * timeline). Each option is a `tab` named by its label and explained by a
 * tooltip, so it stays as legible to assistive tech as the text version it replaces.
 */
export function WorkspaceViewSwitcher({ value, onValueChange, options, label = "View" }: WorkspaceViewSwitcherProps) {
  return (
    <TooltipProvider>
      <Tabs value={value} onValueChange={(next) => onValueChange(next as string)}>
        <TabsList aria-label={label}>
          {options.map((option) => (
            <Tooltip key={option.value}>
              <TooltipTrigger
                render={
                  <TabsTrigger
                    value={option.value}
                    aria-label={option.label}
                    className="min-w-9 px-2.5 max-md:min-w-10 [&_svg:not([class*='size-'])]:size-4"
                  />
                }
              >
                {option.icon}
              </TooltipTrigger>
              <TooltipContent side="bottom">{option.label}</TooltipContent>
            </Tooltip>
          ))}
        </TabsList>
      </Tabs>
    </TooltipProvider>
  );
}
