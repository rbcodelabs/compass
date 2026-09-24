# Geode document storage preview pilot

Compass consumes the published npm package [`@rbcodelabs/geode-headless`](https://www.npmjs.com/package/@rbcodelabs/geode-headless), pinned to exactly `0.1.0` in `package.json` and the pnpm lockfile. Node 22 is required. The release artifact was verified at Geode commit `365438bd38a815dfa1d5230074c395e5ae45f065`. It is byte-identical to the previously verified preview tarball from [Geode SDK PR #268](https://github.com/rbcodelabs/geode/pull/268), original source commit `7fc2c7bc15e015c07a4ad27352833691f43ddc1f`.

Expected SHA-512 integrity (verified against both the registry and the former vendored tarball):
`sha512-gaBHsRTB3NCScAtzHoD0TuLg/gTL+iGJlFyGdtchNpFFvKuT0YSOloco72GvgR9xzD0jZQUnqYzwMt8/ufodZQ==`

The package includes its MIT license, documentation, ESM exports and TypeScript declarations. The SDK's independent Node 22 consumer proof is `npm run proof:headless-package` in the Geode repository. A registry dependency does not enable this pilot or authorize a production rollout.

The SDK owns immutable UTF-8 bodies and verifies their namespace, digest and length. Compass owns authorization, document identity, metadata, hierarchy, history, and the current content reference in DSQL. A body is uploaded before the atomic Compass transaction updates its reference, revision, history and operation receipt. Failed transactions leave the previous document current. The private Blob write-ahead inventory is not authority to delete objects.

## Enabling an isolated preview

Enable only after the existing preview-automation controller has provisioned a disposable schema and synthetic workspace. The ordinary shared `compass_preview` schema is deliberately rejected. Required server environment:

- `PREVIEW_AUTOMATION_ENABLED=1`, `VERCEL_ENV=preview`, valid PR and commit metadata from the preview controller.
- `GEODE_DOCS_PILOT_WORKSPACE_ID`: that synthetic workspace UUID.
- `GEODE_DOCS_BLOB_TOKEN`: an explicitly supplied private-store token.
- `GEODE_DOCS_BLOB_PREFIX`: `geode_docs_` followed by the first 40 hex characters of SHA-256 of `<active-schema>:<workspace-id>`, followed by `/`. Use `documentBlobPrefix(workspaceId)` to compute it.

Only new documents in that workspace use Geode. Existing rows remain database-backed, without backfill. The body limit is 1 MiB. Loss of storage access is an error; Compass does not substitute empty or stale content. Disabling the pilot therefore makes existing Geode documents unavailable until the same configuration is restored.

MCP create requires a UUID `operationId`; pilot updates, snapshots and restores also require `expectedRevision` from `get_doc`. Keep the same operation ID and identical payload on a transport retry. A changed payload or authenticated actor cannot reuse an operation ID. Conflicts require reading the latest document and consciously resubmitting. Tool output and browser payloads never include storage references or Blob paths.

## Local verification

Local verification uses the real packaged SDK and real PostgreSQL but substitutes a filesystem object store for private Blob. It is not evidence of an AWS/Blob deployment. The local adapter is refused outside a non-production, non-Vercel process using `E2E_ISOLATED_DATABASE=1` and a localhost `compass_e2e` database.

Prepare the existing functional-test database under its advisory lock, then run:

```sh
pnpm exec tsx scripts/verify-geode-documents.ts
pnpm exec tsx scripts/verify-geode-document-migration.ts
```

The first script creates and cleans its own synthetic org/workspace and temporary object directory. It exercises registered migration `059_geode_document_storage` twice, checks catalog postconditions, tests operation replay and changed-payload refusal, races two edits, injects a database failure after upload, restores named history, reads through a fresh process and replays deletion. The second creates a unique local schema with pre-feature document/version rows, applies the exact registered migration, proves legacy content remains unchanged with nullable storage columns, reruns it and verifies a single receipt, then removes only its own schema. Neither accepts a cloud database URL.

For the browser fixture, provide `GEODE_DOCS_LOCAL_ROOT` as an existing absolute temporary directory and set `GEODE_DOCS_PILOT_WORKSPACE_ID` to the synthetic fixture workspace. Use the existing functional E2E runner and its database lock. Node 22 is required. The local object adapter hashes logical keys, rejects symbolic links and atomically links completed immutable files.

## Cleanup and rollout

Workspace deletion is blocked while Geode documents, receipts or object inventory remain, or while the workspace is configured as the active pilot. For a cloud pilot: stop writers and unset `GEODE_DOCS_PILOT_WORKSPACE_ID` (redeploy to apply the configuration), export the run evidence, enumerate current and historical references plus pending write inventory, and obtain separate authorization for deletion of that exact isolated prefix. Inventory alone does not identify garbage. Verify removal, then remove only that workspace's synthetic rows and receipts through controlled cleanup. Never delete a shared store or infer permission from a missing document row.

No production rollout, existing-document migration, public npm publication, desktop sync, attachments migration or cloud-wide search is included. Remote verification remains pending until the isolated preview controller and scoped credentials are available.

## Verified error-state layouts

The synthetic local browser journey captures a retained draft after a revision conflict. Retrying does not silently overwrite the other editor's revision; copy the draft before reloading to reconcile it.

![Desktop document conflict with retained draft](../../public/screenshots/docs/geode-docs-pilot-desktop.png)

![Mobile document conflict with retained draft](../../public/screenshots/docs/geode-docs-pilot-mobile.png)
