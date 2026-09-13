import { notFound } from "next/navigation";
import Link from "next/link";
import { getAllDocs, getDoc } from "@/lib/docs";
import type { Metadata } from "next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { HelpAnchorScroll } from "@/components/help-anchor-scroll";

export const dynamic = "force-static";

export async function generateStaticParams() {
  const docs = getAllDocs();
  return docs.map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = await getDoc(slug);
  if (!doc) return {};
  return {
    title: `${doc.title} — Compass Docs`,
    description: doc.description,
  };
}

export default async function HelpSlugPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = await getDoc(slug);
  if (!doc) notFound();

  const allDocs = getAllDocs();
  const currentIndex = allDocs.findIndex((d) => d.slug === slug);
  const prev = currentIndex > 0 ? allDocs[currentIndex - 1] : null;
  const next = currentIndex < allDocs.length - 1 ? allDocs[currentIndex + 1] : null;

  return (
    <article>
      <HelpAnchorScroll />
      <div
        className="docs-content"
        dangerouslySetInnerHTML={{ __html: doc.html }}
      />

      {/* Prev / Next navigation */}
      <div className="mt-12 pt-6 border-t border-slate-200 flex items-center justify-between gap-4">
        {prev ? (
          <Link
            href={`/help/${prev.slug}`}
            className="group flex items-center gap-2 text-sm text-slate-500 hover:text-indigo-600 transition-colors"
          >
            <ChevronLeft className="w-4 h-4 shrink-0 group-hover:-translate-x-0.5 transition-transform" />
            <span>
              <span className="block text-[11px] uppercase tracking-wider text-slate-400 mb-0.5">
                Previous
              </span>
              {prev.title}
            </span>
          </Link>
        ) : (
          <div />
        )}
        {next ? (
          <Link
            href={`/help/${next.slug}`}
            className="group flex items-center gap-2 text-sm text-slate-500 hover:text-indigo-600 transition-colors text-right"
          >
            <span>
              <span className="block text-[11px] uppercase tracking-wider text-slate-400 mb-0.5">
                Next
              </span>
              {next.title}
            </span>
            <ChevronRight className="w-4 h-4 shrink-0 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        ) : (
          <div />
        )}
      </div>
    </article>
  );
}
