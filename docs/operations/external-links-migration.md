# External-link index byte budget and rollout

`126_external_links` retains the complete canonical `external_key` and URL (up to 1000 characters). Both indexes use a separately stored application-computed lowercase SHA-256 hex digest in `external_key_hash VARCHAR(64)`. `provider` and the existing subject/workspace discriminators remain in the index. No database hash function or expression index is required. DSQL does not support indexing `bytea`, so the digest is ASCII hex.

The subject key's declared character limits bound its conservative four-byte UTF-8 payload to `4 * (40 + 30 + 64) + 16 = 552` bytes, below DSQL's 1 KiB key limit. The full external key is never truncated. In the dependent application PR, service deduplication reads by digest and then compares the full key, failing closed on a mismatch. Reverse lookup filters by digest and full key. Import preserves external provider identities and URLs (including UUIDs inside external URLs), ignores a supplied or missing digest and recomputes it after internal subject/workspace identity rewriting, detects collisions before deduplication, and reads back the full key/digest before completing.

## Existing databases

This revision is for fresh installations. Applying the same migration name does not upgrade a database with a finished `126_external_links` receipt: the runner skips it. An unfinished old table also does not acquire the column via `CREATE TABLE IF NOT EXISTS`; terminal catalog checks reject it without a finished receipt. Treat any old schema/receipt as a rollout blocker. Do not delete receipts or treat a changed source pin as evidence of an upgraded environment.

For valuable existing data, preserve it and use a separately reviewed forward migration/backfill or verified export/reimport that derives the digest. The proposed application PR’s import code derives hashes for legacy bundles missing the field, but that contract still needs a tested target schema. Do not rebuild or drop a schema without explicit confirmation that it is disposable and permission to discard its data. There is no automatic repair, backfill or data deletion in this change.

Apply and verify the registered migration before code paths that read external links, including workspace export/deletion. A preview is a later verification gate; neither preview nor production migration is authorized by a local code repair.

## Production verification

For plain PostgreSQL, wait for the production alias to serve the registration. Read migration status and inventory the target catalog before applying. Require compass_prod, only 126_external_links pending, no unresolved attempts and no pre-existing external_links table or receipt. Apply only the named script. Verify one finished receipt, writable digest, primary key and both indexes with their expected columns, uniqueness, validity and readiness. Preserve receipt history on failure. The application rollout follows successful readback.

Aurora DSQL deployments separately require live index admission and ASYNC wait/resume evidence.
