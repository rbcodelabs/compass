"use client";
import { usePathname } from "next/navigation";
import Link from "next/link";

/** Article navigation stays server-authored; only the explorer gets a wider frame. */
export function HelpContentFrame({
  children,
  navigation,
  header,
}: {
  children: React.ReactNode;
  navigation: React.ReactNode;
  header?: React.ReactNode;
}) {
  const explorer = usePathname() === "/help/api-explorer";
  return (
    <>
      {explorer ? (
        <header className="border-b border-border-default bg-surface-navigation px-4 sm:px-8 h-14 flex justify-between items-center gap-3 text-sm">
          <Link href="/help" className="font-semibold">
            Compass{" "}
            <span className="text-text-subtle font-normal hidden sm:inline">
              / Developer
            </span>
          </Link>
          <nav
            aria-label="Developer navigation"
            className="flex gap-3 sm:gap-6 text-xs"
          >
            <Link href="/help/09-rest-api">Guide</Link>
            <Link
              href="/help/api-explorer"
              aria-current="page"
              className="text-primary"
            >
              API explorer
            </Link>
            <a href="/api/v1/openapi.json">OpenAPI ↗</a>
          </nav>
        </header>
      ) : (
        header
      )}
      <div
        className={
          explorer
            ? "flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-8 py-6"
            : "flex-1 max-w-6xl mx-auto w-full flex gap-0 px-4 sm:px-6 py-6 sm:py-8"
        }
      >
        {!explorer && (
          <aside className="hidden md:block w-[220px] shrink-0 pr-8">
            {navigation}
          </aside>
        )}
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </>
  );
}
