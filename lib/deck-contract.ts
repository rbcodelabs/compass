/**
 * The numbers that define how an uploaded HTML Artifact splits into slides.
 *
 * Ported from Commenter / Quick Share
 * (`bankrate-prototypes/v0-comment-service-for-prototypes`, `src/lib/deck-contract.ts`),
 * keeping only the limits Compass enforces. Commenter's upload-size and
 * canvas-fit limits are not carried over: Compass Artifact uploads keep their
 * own size cap, and slides render in the standard sandboxed Artifact frame.
 *
 * The limits live here, not in `slide-parser.ts`, so that `lib/comments.ts`
 * can validate a `slideIndex` against `MAX_SLIDES` without importing cheerio.
 * This module is deliberately dependency-free.
 */

/**
 * The most slides an upload may split into before it is treated as a flat page.
 *
 * A document that splits into hundreds of chunks is almost certainly a
 * mis-detection (for example, decorative `<hr>` rules in a long report) rather
 * than a real deck. Every slide also carries a copy of the shared `<head>`. So
 * past the cap the upload is deliberately NOT truncated, since that would
 * silently discard the tail of someone's document. It falls back to a single
 * document instead, which renders exactly as it would without deck support.
 */
export const MAX_SLIDES = 200

/**
 * The attributes an author puts on a slide element to name and summarise it.
 * `slide-parser.ts` reads them, and the slide navigation shows the title.
 */
export const SLIDE_TITLE_ATTR = "data-slide-title"
export const SLIDE_DESCRIPTION_ATTR = "data-slide-description"

/** The longest slide title kept before truncating with an ellipsis. */
export const MAX_SLIDE_TITLE_LENGTH = 60

/** The longest slide description kept before truncating. */
export const MAX_SLIDE_DESCRIPTION_LENGTH = 140
