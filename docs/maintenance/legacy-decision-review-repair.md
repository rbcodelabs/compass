# Legacy decision review presentation repair

This maintenance command appends a readable `tracked-decision/v2` revision to explicitly allowlisted legacy review requests. It preserves the request ID and URL, leaves the decision cycle pending, and keeps the original revision content and all human records unchanged. The original revision receives only the normal `supersededAt` marker.

It is intentionally not a general migration. It recognizes only the historical Source IDs/Source version, ACTIVE Opportunity IDs, and Current NEXT IDs patterns. Every UUID in the old context must have an explicitly typed reference in the manifest, and every referenced object must resolve inside the selected workspace.

## Manifest

```json
{
  "workspaceId": "00000000-0000-4000-8000-000000000001",
  "requests": [
    {
      "requestId": "00000000-0000-4000-8000-000000000002",
      "expectedRevisionId": "00000000-0000-4000-8000-000000000003",
      "expectedFingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "references": [
        { "type": "EXPERIMENT", "id": "00000000-0000-4000-8000-000000000004" },
        { "type": "ASSUMPTION", "id": "00000000-0000-4000-8000-000000000005" },
        { "type": "EXPERIMENT_RESULT", "id": "00000000-0000-4000-8000-000000000006" }
      ]
    }
  ]
}
```

Supported reference types are `WORKSPACE`, `OPPORTUNITY`, `SOLUTION`, `ASSUMPTION`, `ROADMAP_ITEM`, `DOC`, `EXPERIMENT`, `FEEDBACK`, `EVIDENCE`, `TASK`, and `EXPERIMENT_RESULT`. Manifest order controls source-card presentation; the original context order controls numbered lists. The tool never infers a type or changes the original list order.

## Run a dry-run

Dry-run is the default and performs no transaction or write:

```bash
pnpm maintenance:repair-legacy-decisions -- \
  --manifest /absolute/path/to/manifest.json \
  --schema compass_prod \
  --env-file /absolute/path/to/non-committed.env
```

Use `DATABASE_URL` for local PostgreSQL. For Aurora DSQL, provide `PGHOST`, `PGUSER`, and `AWS_REGION`; the command uses the normal AWS credential chain to mint short-lived DSQL tokens. The schema is always an explicit command argument to prevent an environment default from selecting the wrong tenant schema.

Review every result. `READY` is eligible, `SKIPPED_DECIDED` is intentionally untouched, and `ALREADY_APPLIED` is an idempotent success. `ERROR` and `NOT_ELIGIBLE` produce a non-zero exit.

## Apply

Only after reviewing a clean dry-run, repeat the exact command with `--apply`:

```bash
pnpm maintenance:repair-legacy-decisions -- \
  --manifest /absolute/path/to/manifest.json \
  --schema compass_prod \
  --env-file /absolute/path/to/non-committed.env \
  --apply
```

Each request is repaired in its own transaction. Immediately before writing, the command rechecks workspace, gate, `PENDING` state, v1 packet, revision ID, fingerprint, revision count, decision cycle, and absence of recorded decisions. A concurrent decision or edit causes the transaction to roll back. Repeating the same manifest reports `ALREADY_APPLIED` without adding another revision.

The new revision copies the original title, required role, expiry, source fingerprint, and option definitions. Its summary and packet context contain the readable linked presentation. Source-version and source-fingerprint text moves into repair audit metadata, while the exact original packet, summary, fingerprint, and source prose remain on the superseded revision.
