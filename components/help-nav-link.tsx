"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const isActive = pathname === href;

  return (
    <Link
      href={href}
      className={cn(
        "block rounded-md px-2.5 py-1.5 text-sm transition-colors",
        isActive
          ? "bg-primary/10 text-primary font-medium"
          : "text-text-secondary hover:text-text-primary hover:bg-surface-inset"
      )}
    >
      {label}
    </Link>
  );
}
