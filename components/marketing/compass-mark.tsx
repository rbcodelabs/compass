/**
 * The Compass brand mark — a circle with a compass-needle polygon, stroked
 * white. This exact `<svg>` is duplicated across ~7 files (sidebar.tsx,
 * mobile-header.tsx, onboarding-form.tsx, login/page.tsx, help/layout.tsx,
 * portal layout, preview-login/page.tsx). Extracted here for new call sites;
 * existing usages are left as-is to avoid an unrelated repo-wide refactor.
 *
 * Callers typically wrap this in a small tile, e.g.:
 *   <div className="flex size-7 items-center justify-center rounded-lg bg-primary">
 *     <CompassMark />
 *   </div>
 */
export function CompassMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  )
}
