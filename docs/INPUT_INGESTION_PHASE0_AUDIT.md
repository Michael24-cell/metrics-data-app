# Input, Ingestion, and Athlete Data Management V1 — Phase 0 Audit

Audit date: 2026-07-28  
Repository checkpoint audited: `5d307e1` (`main`)  
Existing Phase 7 checkpoint observed: `78bc4f5`

## Outcome

Protocol blocker status: **resolved by Protocol Milestone A (`a53f7ab`)**.
`tracelab.cmj@1` and `tracelab.imtp@1` now provide the protocol identity,
version, calculation, metadata, channel, and capability contracts required by
the ingestion domain.

The repository has useful tenant, authorization, audit, calculation, metric
registry, monitoring, alert, and Agent foundations. Its current import path is
not a staged ingestion system: CSV text and manual values are parsed in the
request and written immediately to official `session`, `trial`, and `metric`
tables.

At the time of this audit, implementation could not safely enter Phase 1
because the request and repository disagreed about a required dependency:

- The request says versioned test-protocol infrastructure already exists and
  requires every official result to reference a protocol ID and version.
- [`docs/TEST_PROTOCOL_PLATFORM.md`](./TEST_PROTOCOL_PLATFORM.md) explicitly
  says the protocol platform is “future design,” does not authorize
  implementation, and is not available in the current product.
- There are no `protocol_definition`, `protocol_version`,
  `protocol_execution`, or equivalent tables/services. `rts_protocol` is an
  athlete rehabilitation/progression plan, not a test-protocol registry.
- `TEST_TYPES` is a client/server configuration registry for display and
  calculation routing. It has no immutable protocol versions, required
  channels, setup variants, metadata rules, sampling constraints, or
  eligibility policy.

Phase 1 requires staged and official lineage to reference the authoritative
protocol identity. Storing unvalidated protocol strings or inventing CMJ/IMTP
requirements would violate the brief. An approved protocol contract or
authorization to implement the existing future design is required before the
first ingestion migration can be finalized.

## Current implementation map

### Imports and input surfaces

| Responsibility | Current location | Current behavior |
| --- | --- | --- |
| Imports navigation | `src/components/NavLinks.tsx` | Links authorized users to `/import`. |
| Imports page | `src/app/import/page.tsx` | Loads tenant-scoped athletes, sources, batches, and registered metrics. |
| Browser workbench | `src/app/import/ImportClient.tsx` | Pasted long-form CSV and one-metric manual entry; browser constructs payloads but does not calculate metrics. |
| Import API | `src/app/api/imports/route.ts` | Same-origin and `imports.write` protected; tenant comes from server context. Dry-run validates, while normal requests synchronously commit official data. |
| Batch detail API | `src/app/api/imports/[id]/route.ts` | Facility-scoped batch read. |
| Adapter contract | `src/lib/pipeline/adapter.ts` | Six-stage interface, but staging, approval, source preservation, profiles, mappings, units, matching, duplicate review, and revisions are absent. |
| Concrete adapters | `src/lib/pipeline/adapters.ts` | Synthetic, generic CSV, manual, and demo are operational; vendor adapters deliberately throw. |
| Official calculation | `src/lib/pipeline/compute.ts` | Deterministic CMJ/IMTP/drop-jump calculations and official metric/event-marker writes. |

There is no athlete-page Add Data action. The only manual-entry surface is the
Imports page. Its default date is hard-coded to `2026-07-09`, it accepts one
metric at a time, and it writes immediately to official analytics.

### Persistence and migration

| Area | Current location | Reusable foundation / gap |
| --- | --- | --- |
| Schema | `src/lib/db/schema.ts` | Facility-scoped official analytics, auth, audit, monitoring, alerts, Agent records, and generic idempotency exist. No ingestion staging, source-object, mapping, identity, correction, supersession, or durable-job entities exist. |
| Database initialization | `src/lib/db/db.ts` | SQLite/WAL and additive `ADD COLUMN` helper. Schema changes are not represented as ordered, immutable migration files. |
| Migration verification | `scripts/migration-verify.ts` | Checks three legacy additive columns, rerun idempotency, and SQLite integrity. It does not verify ordered migration history, constraints, rollback/restore, or ingestion replay. |
| Tenant DAL | `src/lib/db/dal.ts` | Read functions require a facility ID. Ingestion and several service mutations use direct SQL rather than a shared ingestion DAL. |
| Seed | `scripts/seed.ts` | Builds a two-facility synthetic demo through the existing direct-to-official pipeline. No staged/rejected/pending/correction/reprocessing fixtures exist. |

SQLite child tables generally carry `facility_id`, but most relationships use
single-column foreign keys. The database does not enforce that a child
`facility_id` matches its parent; the current service layer is responsible for
that invariant. New ingestion entities should use tenant-safe composite
constraints or equivalent transaction-time parent validation.

### Authentication, authorization, and audit

| Responsibility | Current location | Assessment |
| --- | --- | --- |
| Auth/session | `src/lib/auth/auth.ts` | Production-required, fail-closed auth configuration; bounded scrypt and opaque database sessions. |
| Context and capability checks | `src/lib/authz.ts` | Active facility is derived from a validated membership. Athlete-scope checks, capability denial audits, and a generic idempotency helper are reusable. |
| Role registry | `src/lib/auth/roles.ts` | Explicit server-side capabilities exist, but ingestion has only broad `imports.write`. Only administrators currently have it; review, approve, mapping, source retrieval, correction, reprocessing, and athlete-submission capabilities are not modeled. |
| Request boundary | `src/lib/requestSecurity.ts` | Exact-host same-origin checks are reusable for mutations. |
| Audit | `src/lib/audit.ts` | Append-only database table and safe metadata contract. `recordAudit` swallows persistence failures, so ingestion commits cannot presently require audit success in the same transaction. |

No import route trusts a browser-supplied facility ID. Athlete IDs from CSV or
manual input are browser supplied, but `validateCanonical` rejects athletes
outside the server-derived facility. The facility-switch route accepts a
requested facility as a preference and validates membership before use.

### Official data and downstream readers

Official analytics use:

- `session` for athlete, facility, device, import batch, test-type string,
  date-only timestamp, and notes.
- `trial` for attempt number, adapter metadata, a downsampled display
  waveform, event markers, and a free-text quality flag.
- `metric` for registered metric key, side, canonical value/unit,
  calculation method version, free-text quality flag, and a coarse source.

Downstream services in `src/lib/services`, the findings engine, team
analytics, reports, monitoring, alerts, curve workspaces, and Agent tools read
these tables as official. They have no authoritative-version or approval
predicate because no staged/current/superseded states exist. Consequently,
adding staged rows to these tables would leak into analytics and Agent
evidence.

`src/lib/agent/prompts.ts` tells the live Agent to treat practitioner notes as
untrusted data. Session notes can nevertheless be returned by
`getSessionDetails`; future uploaded/source text needs a stricter typed
boundary and must never be interpolated into system or task instructions.

### Storage and processing assumptions

- There is no file upload endpoint or multipart boundary. The browser sends
  pasted CSV content inside JSON.
- There is no provider-neutral storage service, immutable source object,
  cryptographic hash, authorized retrieval path, quarantine state, retention
  state, content scan, or production storage configuration.
- Full-rate waveforms live only in a process-local `Map` during synchronous
  import. Only a downsampled 250 Hz display copy is stored. The original signal
  cannot be retrieved, integrity-checked, or reprocessed.
- The local SQLite database is about 26 MB in the audited seeded workspace and
  runs as a single-node WAL database.
- There are no application file-count, byte-size, batch-size, rate, deadline,
  extension, MIME, archive, or expansion limits for ingestion.
- There is no durable queue or worker table. Monitoring is an idempotent
  synchronous service described as a future scheduler boundary; imports and
  findings complete within the browser request.
- No CSV/TSV/ZIP/XLSX fixture files are present in the repository.
- Deployment configuration includes local environment variables and
  Next.js/SQLite only. No object storage, scanner, worker, backup/restore, or
  multi-instance database coordination is configured.

## Integrity gap inventory

### Critical

1. **No test-protocol source of truth.** This is the blocking contract
   contradiction described above.
2. **Direct official writes.** `runImportBatch` calls `importCanonical`,
   `computeCanonical`, and findings generation without review or approval.
3. **No atomic session commit.** A failure after inserting a session or trial
   can leave partial official records. The batch is marked failed but prior
   writes are not rolled back.
4. **No immutable source.** Original CSV or full-rate waveform data is not
   retained. Raw reprocessing and content-integrity verification are
   impossible.
5. **No official/staged/current distinction.** Every persisted session and
   metric is immediately visible to trends, cohorts, monitoring, alerts,
   reports, PR logic, and Agent evidence.
6. **No correction or supersession model.** Official data can only be changed
   by ad hoc SQL/code paths; there is no version history, impact preview, undo,
   authoritative status, or replay contract.

### High

1. Source lineage stops at a mutable-status import batch and adapter. There is
   no source row/sample range, original value/unit, transformation,
   mapping/profile version, match, approver, commit, or correction lineage.
2. `parseCsv` splits on commas and trims lines. It does not support quoted
   cells, embedded delimiters/newlines, BOM, encoding detection, duplicate
   headers, TSV/semicolon formats, mixed numeric formats, or malformed-row
   diagnostics.
3. Values are assumed to already use the metric registry’s canonical unit.
   Original units and deterministic conversions are not stored.
4. Athlete matching requires an internal athlete ID. There are no
   facility-scoped external identities, aliases, candidate matches, or
   concurrent review protections.
5. Duplicate uploads, sessions, attempts, and manual-versus-raw conflicts are
   not detected.
6. Manual and generic CSV inputs use the same direct pipeline but both persist
   metric source as `imported`; the UI claims manual values are stored as
   `manual`.
7. Session time is date-only. Source timezone, facility-timezone assumptions,
   session labels, and effective-dated athlete/team/position/body-mass history
   are absent.
8. Quality and lifecycle state are free text or overly broad. Validation
   issues have no stable code, severity, blocking flag, revision, or affected
   entity.
9. A generic idempotency table exists, but import approval/commit does not use
   it. Browser retries or double clicks can duplicate official sessions.
10. Findings are deleted and regenerated. Historical findings/alerts/Agent
    evidence do not have correction/supersession semantics.

### Existing historical-data limitation

Existing rows have only `metric.source` (`computed`, `imported`, or `manual`),
an import batch where present, and sometimes a device or display waveform.
They do not reliably identify raw versus summary capability. A migration must
classify them conservatively:

- A stored display waveform is not proof that an immutable raw source exists.
- Imported/manual metrics must default to summary-only unless source evidence
  proves otherwise.
- Historical records must not be assigned invented protocol versions,
  original units, mappings, source hashes, or approvers.

## Proposed implementation boundaries

### Domain services

Add focused server-only modules under `src/lib/ingestion`:

- lifecycle and revision state machines;
- source storage, hashing, quarantine, and authorized retrieval;
- parser/adapter detection and deterministic parsing;
- source profiles and immutable mapping versions;
- unit and timezone normalization;
- athlete identity resolution;
- protocol resolution through the approved registry;
- validation issues and duplicate candidates;
- review/approval with optimistic concurrency;
- transaction-safe official commit and full lineage;
- durable downstream jobs and retry;
- manual entry, athlete submissions, corrections, impact preview,
  supersession, and reprocessing.

Calculation functions in `src/lib/calc` remain authoritative. The ingestion
layer may invoke them only after protocol validation; React must never own an
official processing decision.

### Schema and migrations

Phase 1 should introduce ordered, additive, idempotent migrations plus:

- import batches with explicit lifecycle/revision;
- immutable source objects;
- import jobs and downstream jobs;
- source profiles/versions and mapping templates/versions;
- staged sessions, attempts, metrics, matches, duplicates, and validation
  issues;
- approvals and atomic commit records;
- official lineage/current-authority records;
- manual entries, athlete submissions, corrections, and reprocessing runs.

The exact protocol foreign keys cannot be finalized until the blocking
protocol decision is resolved. Existing official tables should not be
destructively rewritten; current rows need conservative legacy lineage and
source-capability states.

### UI surfaces

Evolve `/import` into a permanent workspace with New Import, Review Queue,
History, Source Profiles, Mapping Templates, Unmatched Athletes, Failed Jobs,
Corrections/Reprocessing, and Source Health. Add athlete-page Add Data and a
unified data timeline only after the same server-side domain services exist.
Complex mapping/waveform review remains desktop/tablet-first.

### Security boundaries

- Derive organization, facility, user, and role only from server context.
- Resolve every child through a facility-scoped parent before mutation.
- Split `imports.write` into upload/retrieve/map/profile/match/review/approve/
  manual-entry/submission-approval/correct/reprocess/undo/export/delete
  capabilities.
- Require same-origin mutation, bounded typed request schemas, idempotency,
  optimistic revisions, and audit metadata without raw uploaded text.
- Keep staged, rejected, failed, pending, and superseded data out of all
  official readers by construction, not UI convention.
- Treat filenames, cells, source notes, athlete notes, and uploaded text as
  untrusted data. Never insert them into Agent instructions.

### Processing boundaries

1. Authenticate and derive tenant.
2. Preserve and hash immutable source.
3. Parse and map deterministically.
4. Normalize units/time with recorded assumptions.
5. Resolve athlete and approved protocol.
6. Detect duplicates and validate into staged entities.
7. Review exceptions and approve a specific revision.
8. Atomically create one official session plus lineage.
9. Enqueue idempotent downstream work in the same transaction.
10. Let durable workers update reliability, monitoring, alerts, reports, and
    Agent availability exactly once.

## Test strategy

Each phase should add service-level tests before UI tests:

- schema migration, rerun, integrity, and legacy replay;
- lifecycle transition and immutable-lineage tests;
- role matrix, same-origin, tenant isolation, child-parent isolation, and
  staged-data non-disclosure;
- storage/hash/quarantine/retention and archive-attack fixtures;
- parser fixtures for supported encodings/delimiters/failure modes;
- mapping/profile version replay and format drift;
- unit/timezone/effective-dated metadata;
- athlete identity collision and concurrency;
- protocol-required metadata and direct-API bypass;
- waveform quality and attempt inclusion;
- deterministic duplicate and manual-versus-raw supersession;
- optimistic review/approval and atomic commit failure injection;
- downstream job restart/retry/idempotency;
- manual, athlete submission, correction, impact, undo, and reprocessing;
- browser workflows, keyboard accessibility, role surfaces, and mobile-safe
  simple actions.

After each phase, retain the existing full test, typecheck, production build,
migration, seed, security, monitoring, Agent smoke, and browser gates.

## Reusable foundations

- Server-derived facility/user/role context and capability checks.
- Same-origin mutation guard.
- Facility-scoped read DAL and athlete ownership validation.
- Append-only audit table and generic audit metadata shape.
- Generic idempotency helper (requires operation-specific redesign for
  concurrent approval/commit).
- Deterministic CMJ/IMTP calculators and event-marker generation.
- Registered metric/test configuration and sanity ranges.
- Monitoring/alert dedupe concepts.
- Agent evidence resolver and explicit untrusted-note instruction.
- Multi-tenant seed and security/monitoring/Agent test harnesses.

## Decision required before Phase 1

Choose and approve one of these protocol sources of truth:

1. Authorize implementation of the model in
   `docs/TEST_PROTOCOL_PLATFORM.md`, and provide/approve the CMJ and IMTP V1
   protocol-version content (required channels, sampling constraints, setup
   variants, required metadata, calculations, and eligibility); or
2. Point to the missing protocol migration/branch/commit that the request
   assumes already exists.

Until then, Phase 1 cannot honestly create protocol-bound lineage and must not
invent placeholder protocol identities or scientific requirements.
