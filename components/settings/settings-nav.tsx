"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { activeSettingsHref, type SettingsNavGroup } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";

function BackLink({ href, className }: { href: string; className?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-1.5 text-sm text-text-subtle hover:text-text-primary", className)}>
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Back to Compass
    </Link>
  );
}

/** The grouped link list, shared by the desktop rail and the mobile sheet so they cannot drift apart. */
function NavGroups({ groups, active, onNavigate }: { groups: SettingsNavGroup[]; active: string | null; onNavigate?: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          <p className="px-2 pt-1 text-xs font-semibold uppercase tracking-wide text-text-subtle">
            {group.label}
            {group.sublabel && (
              <span className="block text-xs font-normal normal-case tracking-normal text-text-primary">{group.sublabel}</span>
            )}
          </p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const isActive = item.href === active;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "block rounded-md px-2 py-1.5 text-sm",
                      isActive
                        ? "bg-surface-app font-semibold text-text-primary"
                        : "text-text-subtle hover:bg-surface-app hover:text-text-primary",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

type NavProps = { groups: SettingsNavGroup[]; active: string | null; backHref: string };

/** Desktop rail. Presentational: the caller decides when it is shown (see SettingsNav). */
export function SettingsNavRail({ groups, active, backHref, label = "Settings" }: NavProps & { label?: string }) {
  return (
    <nav aria-label={label} className="w-60 shrink-0 overflow-y-auto border-r border-border-default bg-surface-panel">
      <div className="flex flex-col gap-3 p-4">
        <BackLink href={backHref} className="px-2" />
        <NavGroups groups={groups} active={active} />
      </div>
    </nav>
  );
}

/** Small-screen bar: shows the current page and opens the full grouped list in a sheet. */
export function SettingsMobileBar({ groups, active, backHref }: NavProps) {
  const [open, setOpen] = useState(false);
  const currentLabel = groups.flatMap((g) => g.items).find((item) => item.href === active)?.label ?? "Settings";

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border-default bg-surface-panel px-3 py-2">
      <BackLink href={backHref} />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger render={<Button variant="outline" size="sm" aria-label={`Settings menu, current page ${currentLabel}`} />}>
          <span className="max-w-40 truncate">{currentLabel}</span>
          <ChevronDown aria-hidden="true" />
        </SheetTrigger>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>Settings</SheetTitle>
          </SheetHeader>
          <nav aria-label="Settings sections" className="overflow-y-auto px-4 pb-4">
            <NavGroups groups={groups} active={active} onNavigate={() => setOpen(false)} />
          </nav>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/**
 * Grouped settings navigation. From md up it is a left rail. Below md it is a
 * bar showing the current page; the full list opens in a sheet, so no group is
 * clipped or hidden off-screen on a phone.
 */
export function SettingsNav({ groups, backHref }: { groups: SettingsNavGroup[]; backHref: string }) {
  const pathname = usePathname();
  const active = activeSettingsHref(groups, pathname);

  return (
    <>
      <div className="hidden md:flex">
        <SettingsNavRail groups={groups} active={active} backHref={backHref} />
      </div>
      <div className="md:hidden">
        <SettingsMobileBar groups={groups} active={active} backHref={backHref} />
      </div>
    </>
  );
}
