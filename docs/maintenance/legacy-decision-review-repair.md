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

Confirm the intended `schema` and that `manifest` contains migration 048. If `appliedMigrations` already contains 048, status skips the repair inspection entirely and returns `legacyDecisionReviewRepair` with `available: false`, `skipped: true`, and an explanatory `reason`. Use the verification steps below; this skipped report does not contain repair plans.

Otherwise, confirm that `legacyDecisionReviewRepair` reports the target workspace as `PRESENT`. Review every allowlisted plan: before application each must be `READY`, `ALREADY_APPLIED`, or `SKIPPED_DECIDED`. The authenticated preflight includes the proposed bounded packet/context so operators can inspect the actual readable result before writing; it never includes the original legacy packet.

Repair inspection is informational within the overall status response. If inspection fails, including a connection failure, status returns an unavailable diagnostic (`available: false`, an explanatory `reason`, and an allowlisted error code/category or fixed UNKNOWN category for thrown errors) while allowing the rest of the status check to continue. Driver messages, metadata, and record values are omitted. Pending inspection uses its own one-connection pool with a one-second connection acquisition limit, two-second query/statement limits, and a five-second transaction deadline for all inspection reads. A successful overall status response does not prove that the repair preflight succeeded. An unavailable report does not permit application: resolve the inspection failure and obtain the required preflight evidence before proceeding.

## Apply only migration 048

Do not apply all pending migrations. Production may contain unrelated pending work. Target the repair by name:

```bash
curl -s -X POST https://compass.rbcodelabs.com/api/admin/migrate \
  -H "x-migration-secret: $COMPASS_PRODUCTION_MIGRATION_SECRET" \
  -H "content-type: application/json" \
  -d '{"script":"048_legacy_decision_review_repair"}'
```

Explicit application remains strict; the informational status behavior does not suppress failures from the repair hook, including connection failures. The runner creates an unfinished receipt, executes the data hook, verifies terminal per-request results, and only then marks that receipt finished. An unexpected packet, missing reference, stale revision/fingerprint, or conflicting concurrent edit leaves the attempt unfinished and returns a failure. A human decision is a successful `SKIPPED_DECIDED` terminal result and remains untouched. A retry is safe: already repaired requests report `ALREADY_APPLIED` and never receive duplicate revisions.

Schemas where the exact production workspace does not exist are an explicit no-op, permitting normal dev and preview migration parity. If the workspace exists, missing or mismatched allowlisted requests fail closed.

## Verify

If you just executed the repair, check the successful apply response's `message` field: for a schema containing the target workspace, it must summarize only terminal `ALREADY_APPLIED`, `APPLIED`, or `SKIPPED_DECIDED` per-request results; for an absent target workspace, the `message` field instead reports `target workspace not present`. Repeat the authenticated GET and verify that `appliedMigrations` contains migration 048.

If 048 was already applied before this inspection, verify its existing finished receipt and read back the requests through the normal review API/UI as described below. Do not reapply it to obtain a new POST log. In both cases, the status GET skips repair inspection once 048 is applied and does not repeat the per-request repair plans.

`unresolvedMigrations` is the authoritative current-state signal for stuck work: a name is listed while it has an unfinished attempt and no finished receipt, and it clears once a retry succeeds. An empty `unresolvedMigrations` means nothing is stuck. `incompleteMigrations` is forensic attempt history — one entry per unfinished attempt, duplicates included — so an earlier failed 048 attempt remains listed forever after a successful retry, and its length is never a health check. `retriedMigrations` names those failed-then-succeeded migrations with their `failedAttempts` count, which is where a name that leaves `unresolvedMigrations` by succeeding shows up. The finished receipt and terminal readback remain authoritative for the repair itself.

Two states read as unresolved without owing any work, so cross-check a non-empty `unresolvedMigrations` against `pending` and `notApplicable` before acting:

- **Unresolved but not pending.** A failed decision migration records its unfinished attempt before running any DDL, so a 039 that failed and was then repaired by 042 stays unresolved permanently while `notApplicable` reports it as `satisfied by 042`. There is no retry to run; `migrationReceipts` reports it as `REPAIRED_BY`, which is the decided answer.
- **Unresolved and simultaneously in `appliedMigrations`.** Health reporting classifies deliberately loud: an attempt row whose finished state is not a literal `true`/`false` is alerted on rather than assumed benign, and such a row also passes the separate fail-open test behind `appliedMigrations`. A name in both fields means the attempt history itself is unreadable — inspect `_prisma_migrations` directly rather than trusting either field.

Then read back the allowlisted requests through the normal review API/UI. The nine still-pending requests should retain their URLs and decision cycles while showing readable linked context. The already decided request must remain unchanged.
