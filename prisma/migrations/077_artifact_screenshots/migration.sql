-- Screenshot thumbnails for Artifact revisions.
--
-- A revision may carry one captured PNG of whatever it points at, produced by
-- lib/capture-screenshot.ts. These columns are SIBLINGS of blob_pathname, not a
-- replacement for it: an EXTERNAL_LINK revision has no blob_pathname of its own
-- but can perfectly well have a thumbnail, and an HTML_UPLOAD revision can have
-- both (its content, and a picture of its content rendered).
--
-- thumbnail_source_url records what was actually photographed, AFTER redirects.
-- That is deliberately not assumed to equal the revision's external_url: the two
-- differ whenever the target redirects, and a thumbnail whose provenance is
-- ambiguous is worse than no thumbnail.
--
-- thumbnail_captured_at is the staleness signal. Nothing invalidates a thumbnail
-- when the target page changes (an open question left for follow-up),
-- so the UI needs the capture time to say how old the picture is rather than
-- implying it is current.
--
-- DSQL constraints observed here (the same set as the other plain ADD COLUMN
-- migrations, e.g. 075_roadmap_item_provenance):
--   - Plain ALTER TABLE ADD COLUMN, one column per statement.
--   - No DEFAULT and no NOT NULL on ADD COLUMN — DSQL rejects any constraint
--     there. Every column is therefore nullable, which is also the correct
--     semantics: "no screenshot has been captured for this revision" is the
--     normal state for every row that exists today.
--   - No index. Thumbnails are always reached through the revision row that owns
--     them and are never searched by pathname, so an index would be dead weight.
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_pathname TEXT;
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_mime_type VARCHAR(100);
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_byte_size INTEGER;
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_width INTEGER;
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_height INTEGER;
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_captured_at TIMESTAMP;
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_source_url TEXT;
