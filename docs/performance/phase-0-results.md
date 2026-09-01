# Phase 0 performance baseline

Status: **baseline implementation complete; measurements not yet executed**

This workstream measures Compass before choosing an optimization. It deliberately
does not enable Cache Components, add a cache, change database schema/indexes,
or add dependencies.

## Reproducible run contract

1. Use a clean committed build and record the exact SHA.
2. For local runs, use an optimized `next build` + `next start` server against
   a loopback `compass` database and an owned `compass_perf_<run>` schema.
3. Capture normal Compass authentication to
   `e2e/performance/.auth/user.json`; this ignored file must never be committed.
4. Run only through the externally managed runner, which builds exact HEAD,
   creates the disposable schema before starting the server, validates the
   authenticated runtime, persists local logs, and always tears down:

   ```sh
   COMPASS_PERF_BASELINE=1 \
   PERF_SERVER_KIND=local-production \
   PERF_BASE_URL=http://localhost:<port> \
   PERF_STORAGE_STATE=e2e/performance/.auth/user.json \
   PERF_ORG_SLUG=<org> PERF_WORKSPACE_SLUG=<workspace> \
   PERF_BUILD_SHA=<sha> PERF_EXPECTED_SHA=<sha> \
   pnpm performance:run-local
   ```

Direct local `pnpm test:performance` is invalid because it cannot prove the
running server uses the owned performance schema.

Local raw server logs, the enabled/disabled 20-query observer probe, and
successful browser artifacts are written under `.performance-baseline/`.
Navigation and panel artifacts use stable lane-qualified names such as
`local-production-navigation.json` and
`local-production-panel-opportunity.json`; the same JSON remains attached to
the Playwright result. Ingest an artifact with
`pnpm performance:ingest-local <artifact.json>
.performance-baseline/local-server.log`. Preview logs use
`pnpm performance:ingest-vercel <artifact.json> <vercel.jsonl>`.

Router-cache-hit samples remain in the browser aggregate with null server and
DSQL fields. Only samples with an observed completed request enter server/DSQL
correlation. Each route and panel artifact is version 1 and contains real
sample-count, median, and p95 aggregates calculated from its retained samples.
Navigation aggregates are authoritative per route and, for warm samples, per
`networkOutcome`; overall aggregates are convenience summaries only.

Reconciliation invariant: the set of measured networked custom request IDs
must equal the set of correlated authoritative Vercel invocation IDs and the
set of DSQL custom+platform groups. Router-cache-hit IDs are retained with null
server/DSQL values and excluded from that equality. Unrelated preview traffic
is excluded before grouping and cannot satisfy or fail a measured-sample gate.

The observer-overhead artifact records exact build SHA, three warmups per mode,
20 raw paired samples, alternating order with enabled-first for half the pairs,
query-shape fingerprint, and disabled/enabled median/p95 plus deltas.

5. For the DSQL lane, deploy this commit to an isolated Vercel preview with
   `COMPASS_PERF_BASELINE=1`, use normal preview authentication, run with
   `PERF_SERVER_KIND=vercel-preview`, and collect one-shot deployment logs:

   ```sh
   vercel logs <deployment-id> --no-follow --json
   ```

Every measured networked browser sample carries a unique
`x-compass-perf-request-id`. Its authoritative Vercel invocation and DSQL
events must reconcile to exactly the same custom+platform request pair.
Unrelated preview traffic is excluded before reconciliation. Router Cache hits
remain browser-only samples with null server and DSQL fields. Timestamp-only
matching is forbidden.

## Evidence schema

Committed aggregate evidence may include:

- build SHA, server kind, deployment/region, browser, viewport, and timestamp;
- raw numeric samples plus median and p95;
- cold direct-navigation and warm actual-link results kept separate;
- RSC request count, CDP `encodedDataLength`, and accumulated CDP
  `dataLength` (these are protocol counters, not asserted wire/body sizes);
- request duration, query count and aggregate durations;
- panel shell/API/meaningful-paint latency;
- supported client capabilities and long-task/event/heap values.

Raw logs, traces, SQL, query parameters, cookies, authorization headers,
database URLs, and Vercel bypass values must not be committed. SQL statements
are represented only by operation plus a SHA-256 shape fingerprint.

## Ranked bottlenecks

Pending execution. Rank using:

`affected-journey frequency × median excess latency × confidence`

| Rank | Bottleneck | Evidence | Confidence |
|---|---|---|---|
| — | No measurements yet | The local and preview lanes have not run | — |

## Phase 1 candidates

No candidate is approved until the baseline is complete. Each candidate must
name its supporting samples, expected removable time/bytes/query count, risks,
and a before/after gate using the same dataset, build mode, browser, and sample
count.

Candidates concerning query consolidation, payload deferral, panel prefetch or
bounded client caching, indexes, Cache Components, Redis/shared caching, and
schema changes require separate review and approval.

## Verification gates

- Five fresh-context direct navigations per route.
- Two discarded warmups and ten actual-link navigations per route.
- Navigation readiness includes two animation frames after visible route state.
- Unsupported long-task, event-timing, or heap APIs are `null` with an explicit
  capability flag, never zero.
- Every measured networked sample reconciles to exactly one matching
  custom+platform invocation and its DSQL events; unrelated traffic is excluded
  and Router Cache hits retain null server/DSQL values.
- A repeated local run keeps stable query counts and route medians within 15%,
  or the report downgrades confidence and explains the variance.
- Tests, TypeScript, lint, optimized build, harness, and `git diff --check`
  pass before results are reviewed.

## Known limitations

- Browser-cold navigation is not a Vercel function cold-start measurement.
- Local PostgreSQL establishes repeatability and query shape, not DSQL latency.
- A live, authenticated preview is required for authoritative DSQL duration.
- Query observation adds overhead; enabled-versus-disabled observer overhead
  must be reported alongside absolute timings.

## External execution gates

The implementation is present and fixture-tested, but the evidence review
cannot begin until these environment-dependent runs complete:

- an authenticated optimized local run and authenticated DSQL preview run.
- ingestion of the preview's exported `vercel logs --json` through
  `pnpm performance:ingest-vercel`.
