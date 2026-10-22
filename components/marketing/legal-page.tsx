import type { ReactNode } from "react";
import { LEGAL_LAST_UPDATED } from "@/lib/legal-config";

export interface LegalSection {
  id: string;
  heading: string;
  body: ReactNode;
}

/**
 * Shared prose wrapper for the public Privacy Policy and Terms of Service.
 * Static server component: no data fetching, so both pages stay cacheable.
 */
export function LegalPage({
  title,
  intro,
  sections,
}: {
  title: string;
  intro?: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <article className="break-words max-w-3xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
      <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-text-primary">{title}</h1>
      <p className="mt-2 text-sm text-text-subtle">Last updated: {LEGAL_LAST_UPDATED}</p>
      {intro ? <div className="mt-6 space-y-4 leading-relaxed text-text-secondary">{intro}</div> : null}
      <div className="mt-10 space-y-10">
        {sections.map(section => (
          <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`}>
            <h2
              id={`${section.id}-heading`}
              className="text-xl font-semibold text-text-primary border-b border-border-default pb-2 mb-4"
            >
              {section.heading}
            </h2>
            <div className="space-y-4 leading-relaxed text-text-secondary [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-2 [&_a]:underline [&_a]:text-text-primary [&_code]:text-sm [&_code]:break-all">
              {section.body}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}
