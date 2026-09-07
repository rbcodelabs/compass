import Link from "next/link";
import type { ReactNode } from "react";
import { MarketingNavigation } from "@/components/marketing/marketing-navigation";
import { getMarketingViewer } from "@/lib/marketing-viewer";

export default async function MarketingLayout({ children }: { children: ReactNode }) {
  const viewer = await getMarketingViewer();
  return (
    <>
      {/* Marketing nav */}
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link
            href="/"
            className="font-semibold text-slate-900 text-base tracking-tight"
          >
            Compass
          </Link>
          <MarketingNavigation viewer={viewer} />
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </>
  );
}
