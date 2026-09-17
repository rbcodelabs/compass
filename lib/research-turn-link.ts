/**
 * The one deep-link shape for "show me this exact saved turn".
 *
 * `app/[orgSlug]/[workspaceSlug]/capture/studies/[studyId]/page.tsx` accepts a
 * `?turnId=` query, re-checks workspace membership and study scope, resolves
 * which session the turn is in, and redirects to that session's transcript with
 * a `#turn-<id>` anchor. So a caller only needs the study and the turn — never
 * the session — and the authorization check happens on arrival rather than at
 * link-build time.
 *
 * `components/research/analysis-results.tsx` has built links this way since
 * synthesis results shipped. Extracted here (rather than copied) when ADR-0012
 * step 6a added a second caller in the Evidence surfaces, so the two cannot
 * drift into two different link shapes for the same intent.
 *
 * Deliberately free of any database or server import: this is consumed from
 * client components.
 */
export function researchStudyHref(orgSlug: string, workspaceSlug: string, studyId: string): string {
  return `/${orgSlug}/${workspaceSlug}/capture/studies/${studyId}`
}

export function researchTurnHref(studyHref: string, turnId: string): string {
  return `${studyHref}?turnId=${encodeURIComponent(turnId)}`
}
