# Input, Ingestion, and Athlete Data Management V1 — Phase 1

Status: implemented domain foundation. Secure source upload/storage begins in
Phase 2.

## Domain model

Phase 1 adds facility-scoped persistence for:

- existing `import_batch` with explicit lifecycle state, optimistic revision,
  creator, idempotency key, and update time;
- immutable-source metadata (`source_object`) and processing (`import_job`);
- source profiles and immutable versions;
- mapping templates and immutable versions;
- staged sessions, attempts, and metrics;
- external athlete identities and reviewable matches;
- duplicate candidates and structured validation issues;
- approvals and idempotent commit records;
- manual entries and athlete submissions;
- corrections and reprocessing runs;
- official result lineage;
- append-only lifecycle transition history.

The schema is additive. Existing official sessions and metrics receive
conservative `historical_migration` / `legacy_unverified` lineage. Missing
source objects, mappings, original units, athlete matches, approvals, and
commit records remain null rather than being invented.

## Lifecycle services

`src/lib/ingestion/domain.ts` is the Phase 1 server-only lifecycle boundary.
It provides:

- the complete machine-readable batch and staged-session state sets;
- explicit transition graphs;
- tenant-scoped draft batch creation with idempotent replay;
- tenant-scoped staged-session creation;
- required `tracelab.cmj@1` or `tracelab.imtp@1` identity/version when those
  test types are known;
- optimistic revisions and stale-write rejection;
- append-only transition replay;
- source-classification validation.

Staged entities live in separate tables. Existing analytics, team services,
monitoring, alerts, reports, curves, and Agent evidence continue to read only
official `session`, `trial`, and `metric` tables.

## Batch lifecycle

`draft → uploading → uploaded → parsing → mapping_required|matching →
validating → review_required|ready_for_approval → committing →
processing_downstream → completed|partially_completed`

Explicit failure, cancellation, retry, and supersession edges are defined in
code. Terminal states cannot return to draft.

## Staged-session lifecycle

`unresolved → needs_metadata|needs_match|invalid|quality_limited|
duplicate_review|ready → approved → committing → committed`

Rejection, revalidation, and supersession edges are explicit. A direct
`unresolved → committed` transition is impossible.

## Compatibility boundary

The pre-existing synchronous import route remains operational during this
foundation phase so existing product behavior and seeded analytics do not
regress. Its official writes are labeled `legacy_direct_pipeline` with
`historical_migration` lineage. It is not presented as the completed staged
approval workflow.

Later phases will route supported inputs through immutable source storage,
parsing, review, approval, atomic official commit, and durable downstream
jobs. Phase 1 deliberately does not expose staged writes in the UI or add
staged data to any official reader.

## Tests

`src/lib/ingestion/domain.test.ts` covers:

- complete lifecycle state identities;
- legal and illegal transitions;
- idempotent batch replay;
- optimistic concurrency;
- cross-facility denial;
- explicit protocol identity/version;
- staged-session replay history;
- structural non-disclosure of staged metrics to official analytics.

`scripts/migration-verify.ts` covers the additive table/column set, legacy
lifecycle and lineage backfill, protocol lineage, idempotent rerun, and SQLite
integrity.
