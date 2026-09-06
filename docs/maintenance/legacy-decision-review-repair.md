# Legacy decision review presentation repair

Migration `048_legacy_decision_review_repair` appends a readable `tracked-decision/v2` revision to an exact, packaged allowlist of legacy review requests. It preserves each request ID and URL, leaves the same decision cycle pending, and preserves all human records. The original revision content and metadata remain unchanged except for the normal `supersededAt` marker.

This is not a general backfill. The migration recognizes only the historical Source IDs/Source version, ACTIVE Opportunity IDs, and Current NEXT IDs formats found in the allowlist. Every UUID has an explicitly typed reference, and every reference must resolve inside the selected workspace. Manifest order controls source cards; list order in the original context controls numbered lists.

The repair is registered in Compass’s authenticated migration runner. It does not use a local database command, AWS login, or a separate production credential.

## Preflight

After deploying the code containing migration 048, inspect authenticated status:

```bash
curl -s https://compass.rbcodelabs.com/api/admin/migrate \
  -H "x-migration-secret: $COMPASS_PRODUCTION_MIGRATION_SECRET"
```

Confirm the intended `schema`, that `manifest` contains migration 048, and that `legacyDecisionReviewRepair` reports the target workspace as `PRESENT`. Review every allowlisted plan: before application each must be `READY`, `ALREADY_APPLIED`, or `SKIPPED_DECIDED`. The authenticated preflight includes the proposed bounded packet/context so operators can inspect the actual readable result before writing; it never includes the original legacy packet.

## Apply only migration 048

Do not apply all pending migrations. Production may contain unrelated pending work. Target the repair by name:

```bash
curl -s -X POST https://compass.rbcodelabs.com/api/admin/migrate \
  -H "x-migration-secret: $COMPASS_PRODUCTION_MIGRATION_SECRET" \
  -H "content-type: application/json" \
  -d '{"script":"048_legacy_decision_review_repair"}'
```

The runner creates an unfinished receipt, executes the data hook, verifies terminal per-request results, and only then marks that receipt finished. An unexpected packet, missing reference, stale revision/fingerprint, or conflicting concurrent edit leaves the attempt unfinished and returns a failure. A human decision is a successful `SKIPPED_DECIDED` terminal result and remains untouched. A retry is safe: already repaired requests report `ALREADY_APPLIED` and never receive duplicate revisions.

Schemas where the exact production workspace does not exist are an explicit no-op, permitting normal dev and preview migration parity. If the workspace exists, missing or mismatched allowlisted requests fail closed.

## Verify

Repeat the authenticated GET and verify that `appliedMigrations` contains migration 048 and the repair plans contain only `ALREADY_APPLIED` and `SKIPPED_DECIDED` results. `incompleteMigrations` is forensic attempt history rather than a grouped current state, so an earlier failed 048 attempt can remain listed after a successful retry; the finished receipt and terminal readback are authoritative.

Then read back the allowlisted requests through the normal review API/UI. The nine still-pending requests should retain their URLs and decision cycles while showing readable linked context. The already decided request must remain unchanged.
