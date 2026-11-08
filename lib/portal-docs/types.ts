/**
 * Customer-safe Doc shapes. Client-safe types only. These are the ONLY shapes the public portal path may
 * return for a Doc: no author ids/emails, no metadata, no revision, no storage reference, no parent/seq ids.
 */
export interface PublicDocSummary {
  id: string
  title: string
  /** Plain-text lead of the body, for cards. Derived from the markdown, never HTML. */
  excerpt: string
  /** ISO timestamps. */
  updatedAt: string
  publishedAt: string
}

export interface PublicDoc extends PublicDocSummary {
  /** The doc's markdown source. Phase 2 renders it with the portal's sanitizing markdown renderer. */
  body: string
}
