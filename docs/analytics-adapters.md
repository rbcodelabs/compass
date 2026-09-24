# Analytics adapter contract

Analytics adapters are reviewed, compiled server modules. Compass stores aggregate observations rather than raw events. The registry is `lib/analytics/registry.ts`; shared authorization, revisions, bindings and persistence live in `lib/analytics/service.ts`.

## Implementing another provider

1. Add a typed provider ID and structured query variant in `providers.ts`. Restrict fields, operators, sizes and date ranges; never accept arbitrary URLs, SQL, scripts, or provider expressions from callers.
2. Implement `AnalyticsAdapter`: `id`, `capabilities`, `validate(query)`, and `fetch(context)`. Capabilities declare metrics, filters, maximum window length, and whether the provider supports calendar windows or only current snapshots.
3. Return `ObservationData`: nullable scalar, dated series, `COMPLETE | PARTIAL | UNAVAILABLE`, a coverage note, and secret-free provenance. Missing evidence is never coerced to zero. Respect non-additive metrics such as distinct visitors.
4. Add credential validation and encrypted connection handling through the shared service. Fixed provider hosts, bounded requests, timeout, redirect rejection, structured filters and sanitized errors are required. Network work happens outside database transactions.
5. Add contract tests before enabling the provider in the UI and MCP schemas. Cover real documented response shapes, pagination/truncation, rate limits, malformed data, empty data, UTC boundaries, retention, and unsupported capabilities.

The existing context contains Vercel credentials or an authorized activation counter. A new provider should introduce its own typed credential/context branch rather than reuse a misleading existing one.

## Evidence invariants

- Every definition revision is immutable. Edits require the expected revision.
- A binding pins its revision. Observations preserve the query/window and provenance used at retrieval.
- Retrying the same refresh request does not duplicate observations. Intentional later refreshes use new request IDs.
- An in-flight refresh must not resurrect a disconnected connection, bypass archival, or overwrite a newer attempt's status.
- A delayed successful refresh may persist same-generation observations, but it updates connection health only when no newer attempt owns that status.
- Binding edits are replacement-only: deactivate the active row and create a new ID pinned to the same metric revision and product target. Generated observations remain immutable on the retired binding; there is no observation update API.
- All references belong to the authorized workspace, even for trusted service callers. The installation-wide activation aggregate has an additional operator-workspace guard on both reads and writes.
- Workspace cleanup and analytics insertion share a database write fence because Aurora DSQL has no foreign keys. Observe the existing deletion helpers rather than creating an independent cleanup path.

## Deployment configuration

### Tracking policies and rollout

Tracking uses the existing binding JSON columns: `baselineJson` contains JSON `null`, and `followupJson` contains a versioned rolling policy. Legacy paired fixed windows remain comparisons. This requires no database migration. Readers must understand the policy union before writers create tracking bindings: reverting to an older application after such records exist is not a transparent rollback.

Resolve a new rolling refresh once, using one attempt timestamp. Vercel windows end yesterday in UTC and include the requested number of completed days. Activation retains its current trailing 30×24-hour snapshot semantics. Persist the concrete window and policy provenance with immutable evidence. Completed request replays must be found before recalculating rolling dates. Tracking expects only `FOLLOWUP`; comparison expects both `BASELINE` and `FOLLOWUP`.

`ANALYTICS_SECRET_ENCRYPTION_KEY` is a dedicated base64-encoded 32-byte encryption key. It is not the portal SSO key. Keep it stable while stored connection credentials need to be decrypted; a key rotation requires a separately planned credential migration or reconnection.

Compass activation uses `COMPASS_ANALYTICS_REPORTING_WORKSPACE_ID`, `COMPASS_ANALYTICS_COLLECTION_STARTED_AT` (an actual prospective deployment timestamp), and optional comma-separated `COMPASS_ANALYTICS_EXCLUDED_WORKSPACE_IDS`. Collect only in production. Do not backdate the collection epoch to imply evidence that was never captured.

The server telemetry relay uses the same dedicated analytics key with a domain-separated HMAC, a short timestamp validity window, a fixed route and deployment-configured origin. It receives only allowlisted action/source values. It never forwards the original product request URL or headers to the analytics SDK. Failure to deliver telemetry is best effort and must not invalidate committed work.

Before production use, apply the exact registered migration, configure the dedicated key, enable Web Analytics for the chosen Vercel project, connect with a human administrator, and compare an identical UTC interval against Vercel's dashboard. Tests with synthetic fixtures do not establish real account access or reporting agreement. Production migration and rollout require separate authorization.

## Local fixtures

The deterministic transport fixture is restricted to development, the explicit isolated-E2E guard, and the local `compass_e2e` database. It cannot be activated on a Vercel deployment. Browser tests must use the repository's functional wrapper so database preparation, serialization and cleanup remain enforced.
