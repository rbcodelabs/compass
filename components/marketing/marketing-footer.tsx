import Link from "next/link";
import type { MarketingViewer } from "@/lib/marketing-viewer";

export function MarketingFooter({ viewer }: { viewer: MarketingViewer }) {
  const isSignedOut = viewer.kind === "signed-out";
  const accountHref = !isSignedOut && viewer.kind === "no-workspaces" ? "/onboarding" : "/dashboard";
  const accountLabel = isSignedOut
    ? "Sign in"
    : viewer.kind === "no-workspaces"
      ? "Set up workspace"
      : "Dashboard";
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        {/* Left: wordmark + copyright */}
        <div className="flex items-center gap-2 text-slate-600">
          <span className="font-semibold text-slate-900">Compass</span>
          <span className="text-slate-300">·</span>
          <span className="text-sm">© 2026 RB Code Labs</span>
        </div>

        {/* Right: nav links */}
        <nav className="flex items-center gap-6 text-sm text-slate-500">
          <Link
            href={isSignedOut ? "/login" : accountHref}
            className="hover:text-slate-900 transition-colors"
          >
            {accountLabel}
          </Link>
          <Link
            href="/help"
            className="hover:text-slate-900 transition-colors"
          >
            User Guide
          </Link>
          <Link
            href="/portal/rbcodelabs/compass/roadmap"
            className="hover:text-slate-900 transition-colors"
          >
            Roadmap
          </Link>
          <Link
            href="/portal/rbcodelabs/compass/feedback"
            className="hover:text-slate-900 transition-colors"
          >
            Give feedback
          </Link>
        </nav>
      </div>
    </footer>
  );
}
