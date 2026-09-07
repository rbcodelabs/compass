import Link from "next/link";
import { cn } from "@/lib/utils";
import type { MarketingViewer } from "@/lib/marketing-viewer";

const KANBAN_COLUMNS = [
  {
    title: "Exploring",
    cards: [
      "Founders don't know how to write a good discussion guide",
      "Participants can't share interviews easily",
      "No way to track drop-off mid-interview",
    ],
    badge: "EXPLORING",
    badgeClass: "bg-slate-700 text-slate-300",
    cardClass: "",
  },
  {
    title: "Validated",
    cards: [
      "No landing page before public launch",
      "Synthesis not connected to next decision",
    ],
    badge: "VALIDATED",
    badgeClass: "bg-indigo-900/60 text-indigo-300",
    cardClass: "ring-1 ring-indigo-500/20",
  },
  {
    title: "In Delivery",
    cards: ["Public OST share link"],
    badge: "IN DELIVERY",
    badgeClass: "bg-emerald-900/60 text-emerald-300",
    cardClass: "ring-1 ring-emerald-500/20",
  },
];

export function HeroSection({ viewer }: { viewer: MarketingViewer }) {
  const isSignedOut = viewer.kind === "signed-out";
  const primaryLabel = isSignedOut
    ? "Start for free →"
    : viewer.kind === "no-workspaces"
      ? "Set up workspace"
      : "Open Compass";
  const primaryHref = !isSignedOut && viewer.kind === "no-workspaces" ? "/onboarding" : "/dashboard";
  return (
    <section className="bg-slate-950 text-white py-20 lg:py-28">
      <div className="max-w-6xl mx-auto px-6 grid lg:grid-cols-2 gap-16 items-center">
        {/* Left: copy */}
        <div className="flex min-w-0 flex-col gap-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
            Continuous Discovery
          </p>
          <h1 className="text-4xl lg:text-5xl font-bold leading-tight tracking-tight">
            From customer insight to shipped feature —{" "}
            <span className="text-indigo-400">all connected.</span>
          </h1>
          <p className="text-lg text-slate-400 leading-relaxed max-w-md">
            Compass gives your product team one place to link OKRs to
            opportunities, run experiments before committing, and ship features
            with the evidence attached.
          </p>
          <div className="flex items-center gap-5 pt-2">
            <Link
              href={primaryHref}
              className="inline-block bg-indigo-600 hover:bg-indigo-500 transition-colors text-white font-semibold rounded-lg px-6 py-3 text-base"
            >
              {primaryLabel}
            </Link>
            {isSignedOut && (
              <Link
                href="/login"
                className="text-slate-400 hover:text-slate-200 transition-colors text-base"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>

        {/* Right: browser chrome mock */}
        <div aria-hidden="true" className="min-w-0 w-full">
          <div className="rounded-xl border border-white/10 bg-slate-900 shadow-2xl overflow-hidden">
            {/* Browser top bar */}
            <div className="flex items-center gap-3 px-4 py-3 bg-slate-800/80 border-b border-white/10">
              {/* Traffic lights */}
              <div className="flex gap-1.5">
                <span className="w-3 h-3 rounded-full bg-red-500/80" />
                <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <span className="w-3 h-3 rounded-full bg-green-500/80" />
              </div>
              {/* URL bar */}
              <div className="flex-1 bg-slate-700 rounded px-3 py-1 text-xs text-slate-400 font-mono truncate">
                compass.rbcodelabs.com/rbcodelabs/compass/discovery
              </div>
            </div>

            {/* Kanban content */}
            <div className="p-4 grid grid-cols-3 gap-3 min-h-[280px]">
              {KANBAN_COLUMNS.map((col) => (
                <div key={col.title} className="flex min-w-0 flex-col gap-2">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                    {col.title}
                  </p>
                  {col.cards.map((card) => (
                    <div
                      key={card}
                      className={cn(
                        "bg-slate-800 rounded-lg p-3 flex flex-col gap-2",
                        col.cardClass
                      )}
                    >
                      <span
                        className={cn(
                          "self-start text-[9px] font-bold px-1.5 py-0.5 rounded",
                          col.badgeClass
                        )}
                      >
                        {col.badge}
                      </span>
                      <p className="text-xs text-slate-300 leading-snug line-clamp-3">
                        {card}
                      </p>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
