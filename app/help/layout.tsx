import Link from "next/link";
import { getAllDocs } from "@/lib/docs";
import { NavLink } from "@/components/help-nav-link";

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  const docs = getAllDocs();

  // Group docs by section, preserving order
  const sections: Record<string, typeof docs> = {};
  for (const doc of docs) {
    if (!sections[doc.section]) sections[doc.section] = [];
    sections[doc.section].push(doc);
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Top bar */}
      <header className="bg-slate-950 text-white border-b border-slate-800/50 shrink-0">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-3">
          <Link href="/help" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
            <div className="w-6 h-6 rounded-md bg-indigo-500 flex items-center justify-center shrink-0">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-3.5 h-3.5"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
              </svg>
            </div>
            <span className="font-semibold text-sm tracking-tight">Compass</span>
            <span className="text-slate-500 text-sm">/</span>
            <span className="text-slate-300 text-sm">Docs</span>
          </Link>
        </div>
      </header>

      <div className="flex-1 max-w-6xl mx-auto w-full flex gap-0 px-6 py-8">
        {/* Sidebar */}
        <aside className="w-[220px] shrink-0 pr-8">
          <nav aria-label="Documentation navigation">
            {Object.entries(sections).map(([section, sectionDocs]) => (
              <div key={section} className="mb-6">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2 px-1">
                  {section}
                </p>
                <ul className="space-y-0.5">
                  {sectionDocs.map((doc) => (
                    <li key={doc.slug}>
                      <NavLink href={`/help/${doc.slug}`} label={doc.title} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <main className="flex-1 min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
