import Link from "next/link"
import { CompassMark } from "@/components/marketing/compass-mark"

const SEGMENT_CLASS =
  "flex items-center gap-1.5 rounded-full px-2 sm:px-2.5 py-1 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-interactive-hover hover:text-text-primary"

// Labels collapse to icon-only below `sm` so the switcher fits the 390px
// mobile header alongside the wordmark and account menu (see pr-guidelines
// mobile viewport check). Each link still carries an explicit aria-label so
// its accessible name doesn't depend on the visually hidden text.
const LABEL_CLASS = "hidden sm:inline"

/**
 * Rounded segmented control in the marketing header that lets visitors jump
 * to Rick's sibling products (Geode, Claude Threads). Each product is its
 * own subdomain with no shared package — this switcher is implemented
 * natively in each repo (geode-site, claude-threads-site, compass) following
 * the same visual/interaction spec.
 *
 * Plain links styled as a segmented control, not a form-input widget: this is
 * navigation between sites, not a selectable value, so it intentionally does
 * not use shadcn's ToggleGroup or a role="radiogroup" pattern.
 */
export function ProductSwitcher() {
  return (
    <nav aria-label="Product family">
      <div className="inline-flex items-center gap-1 rounded-full border border-border-default bg-surface-inset p-1">
        <span
          aria-current="page"
          aria-label="Compass"
          className="flex items-center gap-1.5 rounded-full bg-accent px-2 sm:px-2.5 py-1 text-sm font-medium text-accent-foreground"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary">
            <CompassMark className="size-3.5" />
          </span>
          <span className={LABEL_CLASS}>Compass</span>
        </span>

        <Link href="https://geode.rbcodelabs.com" aria-label="Geode" className={SEGMENT_CLASS}>
          <svg viewBox="0 0 32 32" fill="none" className="size-5 shrink-0" aria-hidden="true">
            <defs>
              <linearGradient id="product-switcher-geode" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#DBEA9D" />
                <stop offset="1" stopColor="#789348" />
              </linearGradient>
            </defs>
            <rect width="32" height="32" rx="8" fill="#294835" />
            <rect x="1" y="1" width="30" height="30" rx="7" stroke="url(#product-switcher-geode)" strokeWidth="1.5" />
            <path d="M16 6L24 12L21 26H11L8 12L16 6Z" fill="url(#product-switcher-geode)" />
            <path d="M16 6L24 12L21 26L16 16L16 6Z" fill="#294835" fillOpacity="0.24" />
            <path d="M16 6V16L11 26L8 12L16 6Z" fill="#294835" fillOpacity="0.08" />
          </svg>
          <span className={LABEL_CLASS}>Geode</span>
        </Link>

        <Link href="https://threads.rbcodelabs.com" aria-label="Threads" className={SEGMENT_CLASS}>
          <svg viewBox="0 0 32 32" fill="none" className="size-5 shrink-0" aria-hidden="true">
            <defs>
              <linearGradient id="product-switcher-threads" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#7C3AED" />
                <stop offset="1" stopColor="#6366F1" />
              </linearGradient>
            </defs>
            <rect width="32" height="32" rx="8" fill="#0B0B10" />
            <rect x="1" y="1" width="30" height="30" rx="7" stroke="url(#product-switcher-threads)" strokeWidth="1.5" />
            <path
              d="M9 12.5C9 10.567 10.567 9 12.5 9H19.5C21.433 9 23 10.567 23 12.5V17.5C23 19.433 21.433 21 19.5 21H14L10 24.5V21H12.5C10.567 21 9 19.433 9 17.5V12.5Z"
              fill="url(#product-switcher-threads)"
            />
            <circle cx="13" cy="15" r="1.2" fill="#0B0B10" />
            <circle cx="16" cy="15" r="1.2" fill="#0B0B10" />
            <circle cx="19" cy="15" r="1.2" fill="#0B0B10" />
          </svg>
          <span className={LABEL_CLASS}>Threads</span>
        </Link>
      </div>
    </nav>
  )
}
