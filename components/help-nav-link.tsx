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
          ? "bg-indigo-600/10 text-indigo-700 font-medium"
          : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
      )}
    >
      {label}
    </Link>
  );
}
