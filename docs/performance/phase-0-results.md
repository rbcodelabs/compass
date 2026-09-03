# Phase 0 performance baseline

Status: **local production-build baseline complete and repeatable; preview/DSQL
lane blocked on authorized OAuth callback configuration; Phase 0 incomplete**

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
correlation. Each route and panel artifact is version 2 and contains real
sample-count, median, and p95 aggregates calculated from its retained samples.
Each sample also contains a `requests` list. Browser response `x-vercel-id`
hashes are retained as provenance, but Vercel exposes different edge-response
and Function request IDs. Correlation therefore requires exactly one
authoritative platform invocation with the same method, exact pathname, success
status, and start timestamp within ±500 ms. The selected platform request ID
then binds its DSQL envelopes, which must contain exactly one internally
consistent query request ID. Zero or multiple candidates fail closed.
The retained Vercel CLI schema does not provide Function duration. Ingested
server-duration fields are therefore `null` with an explicit availability
count, never synthesized as zero; browser latency and DSQL query timing remain
available.
Overlapping Vercel time-slice exports for the same platform request are merged
only when every outer invocation field is identical. Nested log records are
canonical-set-unioned before query parsing; an exactly repeated timestamp,
level, and message is treated as export duplication rather than a second query.
Only the `serverless` phase is authoritative. A same-ID
`serverless-middleware` companion is ignored only when all other outer fields
match and every middleware log is already contained in the serverless union;
middleware-only, divergent, additive, or other-source evidence fails closed.
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

Every measured networked browser sample carries a scoped
`x-compass-perf-request-id`; every completed target request retains distinct
edge provenance. Exact method/path and the bounded ±500 ms start window select
one platform request, and only that platform request's internally consistent
DSQL envelopes enter the result.
Unrelated preview traffic is excluded before reconciliation. Router Cache hits
remain browser-only samples with null server and DSQL fields. Timestamp-only
matching is forbidden.

## Execution evidence

### Local production-build lane

Two clean optimized local runs measured exact code SHA
`0a8fbae4801756a46355c47952eb78478d224bba`. Each run used `next build` +
`next start`, its own sentinel-owned disposable PostgreSQL schema, Chromium
149.0.7827.55 at 1440×900, and normal Compass authentication.

| Run | Navigation total | Warm outcomes | Cold | Opportunity panel | Roadmap Item panel | Local request/query correlation |
|---|---:|---|---:|---:|---:|---:|
| 1 | 60 | 37 completed RSC, 3 canceled speculative | 20 | 10 | 10 | 80/80 unique sample IDs |
| 2 | 60 | 39 completed RSC, 1 canceled speculative | 20 | 10 | 10 | 80/80 unique sample IDs |

The 60 navigation samples in each run comprise 40 retained warm link
navigations and 20 fresh-context cold document navigations. All 160 retained
samples across both runs have one local correlation record with positive query
counts; the four canceled-speculative warm samples remain explicitly classified
rather than being silently counted as completed payloads.

Repeatability passed the documented local gate:

- maximum absolute route-median drift was 14.76%;
- maximum panel meaningful-paint median drift was 5.13%;
- reported query-count summaries were identical for every matching route and
  panel;
- fingerprint sets matched fully: navigation 47/47, Opportunity panel 18/18,
  and Roadmap Item panel 41/41;
- observer overhead was +0.0117 ms median / +0.0275 ms p95 in run 1 and
  +0.0132 ms median / +0.0164 ms p95 in run 2.

Cleanup was also verified. The orchestrator attested that, after run 2, a
read-only query against the dedicated localhost:5437 `compass` database found
exactly zero `compass_perf_*` schemas. `.performance-baseline/run.json` and
`e2e/performance/.auth/user.json` were absent. It then fast-stopped the owned
PostgreSQL cluster, verified `postmaster.pid` was absent, and removed only the
validated `/tmp/compass-perf-pg.xOcLzS` directory.

### Preview/DSQL lane

The exact measured commit was deployed to Vercel for read-only measurement as
deployment `dpl_6Kf7JXNTuRu2AaAWoznGoABcW4Bn` at
`https://compass-brea5dc7o-rbcodelabs-team.vercel.app`. The deployment was
READY in `iad1`, used both git SHA and `PERF_BUILD_SHA`
`0a8fbae4801756a46355c47952eb78478d224bba`, and had no alias.

Normal Google authentication could not complete because Google returned
`redirect_uri_mismatch` for that deployment's callback. No preview browser
samples, authoritative Vercel invocation correlations, or DSQL query evidence
were collected. The compliant unblock is either an authorized stable preview
alias whose callback is already registered, or registration of this exact
deployment callback:
`https://compass-brea5dc7o-rbcodelabs-team.vercel.app/api/auth/callback/google`.
The lane must continue to use normal authentication; no auth bypass or weakened
gate is permitted.

Consequently, Phase 0 remains incomplete. Local PostgreSQL evidence supports
repeatability and provisional investigation priorities only. No
production-impact claim is supportable without the preview/Vercel/DSQL lane.

## Evidence schema

Committed aggregate evidence may include:

- build SHA, server kind, deployment/region, browser project, engine/version,
  viewport, and timestamp;
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

This is a provisional **local severity/repeatability ranking only**. Journey
frequency was not measured, so this is not the full
`frequency × excess latency × confidence` prioritization model. Byte values are
CDP protocol counters, not asserted wire or body sizes.

| Rank | Bottleneck | Local evidence across runs 1–2 | Confidence |
|---:|---|---|---|
| 1 | Cold Roadmap initial render | 231–237 ms median; 81 queries; 55–56 ms median summed query work; 822 KB decoded and 41 KB encoded CDP counters; ~186 ms main-thread task duration | High local |
| 2 | Cold Tasks | 207–210 ms median; 158 queries; 105–112 ms summed query work; 601 KB decoded and 32 KB encoded CDP counters; 166–168 ms task duration | High local |
| 3 | Roadmap Item panel | 153–161 ms meaningful paint; 74 queries; 33–34 ms summed query work; ~101 ms task duration | High local |
| 4 | Cold Feedback | 157–160 ms median; 53 queries; 30–35 ms summed query work; 306 KB decoded CDP counter; ~141 ms task duration | High local |
| 5 | Warm Roadmap | 144–159 ms median; 27 queries; ~22 ms summed query work; completed RSC ~101 KB decoded CDP counter; 115–117 ms task duration | Medium-high local |

Summed query duration is observation work summed across queries that may overlap
or run concurrently. It is not directly removable critical-path time and must
not be presented as expected latency savings.

## Phase 1 candidates

These are investigation candidates from the independent local evidence review;
none is approved. Production magnitude and final priority await preview/DSQL
evidence.

### A. Reduce cold Tasks query fan-out

- Direction: fewer DSQL round trips and less server work; exact removable
  milliseconds are unknown.
- Risks: incomplete relations, authorization regressions, or incorrect derived
  counts.
- Gates: data and authorization parity, materially fewer queries, improved cold
  median and p95, and confirmation against preview DSQL.

### B. Reduce or defer cold Roadmap data/render work

- Direction: lower serialization, hydration, and main-thread work.
- Risks: missing initial content, layout shift, delayed interaction, or reduced
  accessibility.
- Gates: preserve visible content and interactions while improving decoded CDP
  counter, task duration, and cold median.

### C. Consolidate Roadmap Item panel loading

- Direction: lower response and meaningful-paint latency.
- Risks: broader payloads, stale relations, or permission leakage.
- Gates: exact response and authorization parity, lower query count, and better
  median and p95.

### D. Reduce cold Roadmap/Tasks client render work

- Direction: reach semantic readiness earlier independently of database work.
- Risks: unsafe memoization, delayed state, or broken interactions.
- Gates: task duration and route latency improve together with visible-state and
  interaction parity.

### E. Isolate the warm Tasks first/full-load path

- Evidence: both runs show an 11-query median but 116-query p95.
- Direction: investigation only; impact is not yet quantified.
- Risk: misclassifying required initialization as redundant work.
- Gate: a stratified before/after profile that separates first/full-load and
  steady-state warm samples.

Candidates concerning query consolidation, payload deferral, panel prefetch or
bounded client caching, indexes, Cache Components, Redis/shared caching, and
schema changes require separate review and approval.

## Verification gates

- Five fresh-context direct navigations per route.
- Two discarded warmups and ten actual-link navigations per route.
- The navigation ceiling is derived from one bounded 5-second Playwright
  completion wait per warm attempt, one 100 ms collector-quiescence wait per
  matrix attempt, and 60 seconds of browser/readiness headroom (276,200 ms for
  the 2 + 40 + 20 matrix). Panel tests retain the fail-closed 120-second global
  ceiling.
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
- Per-sample resource arrays and resource fields are authoritative for sample
  analysis. The navigation artifact's top-level `resources` rollup is not an
  authoritative cross-sample total and must not be used for ranking or savings
  claims.

## External execution gates

The local evidence review is complete. Phase 0 remains gated on:

- authorized normal authentication to the exact preview deployment or an
  authorized stable preview alias/callback;
- the full preview browser matrix against that authenticated deployment;
- one-shot Vercel log export and ingestion through
  `pnpm performance:ingest-vercel`;
- exact browser → Vercel invocation → DSQL correlation review.
