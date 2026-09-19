import Link from "next/link";
import type { ReactNode } from "react";
import { MarketingNavigation } from "@/components/marketing/marketing-navigation";
import { ProductSwitcher } from "@/components/marketing/product-switcher";
import { getMarketingViewer } from "@/lib/marketing-viewer";

export default async function MarketingLayout({ children }: { children: ReactNode }) {
  const viewer = await getMarketingViewer();
  return (
    <>
      {/* Marketing nav */}
      <header className="border-b border-border-default bg-surface-panel">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <Link
              href="/"
              className="shrink-0 font-semibold text-text-primary text-base tracking-tight"
            >
              Compass
            </Link>
            <ProductSwitcher />
          </div>
          <MarketingNavigation viewer={viewer} />
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </>
  );
}
