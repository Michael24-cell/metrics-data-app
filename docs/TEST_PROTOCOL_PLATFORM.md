# Test Protocol Platform

Status: **Protocol Milestone A implemented for existing CMJ and IMTP behavior.**
Facility-authored protocols, assignments, execution workflows, reviews, and
additional test types remain future design.

## Implemented in Milestone A

The application now has a small immutable protocol kernel for:

- `tracelab.cmj@1` — existing Countermovement Jump calculation version
  `1.0.0`.
- `tracelab.imtp@1` — existing Isometric Mid-Thigh Pull calculation version
  `1.0.0`.

The runtime contract is defined in `src/lib/protocols/registry.ts`. It declares:

- stable protocol identity and version;
- the required total vertical-force channel in N;
- optional paired left/right force channels in N;
- a required positive finite sample rate;
- required athlete identity and ISO session date;
- the single existing `standard` setup variant (no new setup assumptions);
- existing calculator-owned attempt validation and quality capabilities;
- official metrics and existing event-marker fields;
- force-time visualization, monitoring, team-analysis, Agent, and raw
  reprocessing capability;
- the exact existing calculation version.

`src/lib/protocols/persistence.ts` installs and verifies the immutable catalog
in `test_protocol_definition` and `test_protocol_version`. Protocol and
calculation lineage is persisted on CMJ/IMTP sessions, trials, and metrics.
Existing rows are additively backfilled from their established `test_type` and
metric method version. Setup metadata is left empty instead of invented.

The pipeline resolves CMJ and IMTP through this contract before invoking the
unchanged functions in `src/lib/calc/cmj.ts`, `src/lib/calc/imtp.ts`, and
`src/lib/calc/curve.ts`. Golden-master tests prove the wrapper returns the
same results and event markers.

Milestone A does **not** add or authorize Squat Jump, Drop Jump, 10–5 RJT,
Isometric Squat, Loaded CMJ, DSI, or any other protocol. Existing Drop Jump
code remains outside this protocol kernel and is not represented as a
published protocol.

## Milestone A implementation map

| Boundary | Implementation |
| --- | --- |
| Immutable contract and discovery | `src/lib/protocols/registry.ts` |
| Catalog persistence and legacy lineage | `src/lib/protocols/persistence.ts` |
| Schema and additive migration hook | `src/lib/db/schema.ts`, `src/lib/db/db.ts` |
| Ingestion selection and required-input enforcement | `src/lib/pipeline/adapter.ts`, `src/lib/pipeline/adapters.ts` |
| Official calculation dispatch and metric lineage | `src/lib/pipeline/compute.ts` |
| Application test labels/curve capability | `src/lib/config/metrics.ts` |
| Golden masters, replay, capability, validation, and persistence | `src/lib/protocols/protocols.test.ts` |
| Migration/backfill verification | `scripts/migration-verify.ts` |

Hard-coded CMJ/IMTP dispatch was removed from the official calculation
pipeline and replaced by protocol discovery. Test labels and curve
availability now read the protocol contract.

Formula-specific metric persistence remains explicit in
`src/lib/pipeline/compute.ts`. This is intentional: it is the smallest clear
adapter from the typed result objects to the existing metric schema, and
turning it into a generic rules engine would obscure the approved behavior.
CMJ/IMTP event algorithms, thresholds, warnings, and formula implementations
remain hard-coded in their validated calculator modules for the same reason.
Curve annotations retain explicit CMJ/IMTP typing because the two marker
shapes are intentionally different.

## Milestone A lifecycle

The two built-in versions are system-scoped, published, and immutable. There
is no UI or API for editing them. A scientific or calculation change requires
a new explicit protocol version and calculation version; an existing catalog
hash mismatch fails closed during database initialization.

## Purpose

Provide a versioned, tenant-scoped way for administrators and coaches to
define test protocols, assign them to athletes or teams, capture execution
context, validate comparable observations, and hand accepted results to the
existing deterministic calculation and monitoring systems.

## Future domain model

- `protocol_definition`: facility-owned stable identity and lifecycle.
- `protocol_version`: immutable ordered steps, instructions, equipment,
  units, validation rules, calculation-method versions, and effective dates.
- `protocol_assignment`: athlete/team assignment to one exact version,
  authored by an authorized user.
- `protocol_execution`: one server-created attempt with operator, facility,
  athlete, timestamps, device/configuration, and state.
- `protocol_step_result`: raw/reference identifiers, accepted value, unit,
  quality flags, provenance, and amendment lineage.
- `protocol_review`: append-only accept/reject/amend decision; amendments
  create a new result version and never overwrite accepted history.

These facility-authored entities are not implemented by Milestone A. When
implemented, every athlete-bearing row must carry `facility_id`; foreign keys and service
queries validate the facility, athlete, assignment, execution, and child row
together. Browser-provided facility IDs are never authoritative.

## Future lifecycle

`draft → reviewed → published → retired`. Published versions are immutable.
Assignments reference a published version. Executions progress
`planned → in_progress → submitted → accepted|rejected`; only accepted results
enter analytics. Interrupted work is resumable through idempotent,
server-issued submission keys.

## Future authorization

- Admin: create, review, publish, retire, assign, and inspect audit history.
- Coach: assign published protocols, execute, submit, and review where granted.
- Analyst: view accepted results and provenance; no protocol mutation.
- Read-only: view accepted results only.

Every mutation requires authenticated same-origin requests, an explicit
capability, a tenant-scoped parent lookup, optimistic concurrency/version
checks, and an audit event.

## Integrity and statistics

Protocol versions pin metric identity, absolute versus normalized form, unit,
device/configuration requirements, comparable-observation rules, and approved
CV/TE/SWC/MDC policy references. TE consumes only valid paired comparable
observations. MDC requires valid TE and a configured confidence level. A
protocol cannot silently introduce a universal SWC method. Historical results
retain the exact protocol, calculation, and monitoring-policy versions.

## Future API outline

- Read definitions/versions/assignments through tenant-scoped services.
- Create drafts and publish with `If-Match`/version checks.
- Start an execution server-side; never accept facility ownership from input.
- Submit step results with idempotency keys and bounded payloads.
- Accept/reject through append-only review records.
- Export only accepted data through `exports.create`, with audit events.

## Future rollout gates

1. Schema migration and rollback/restore rehearsal.
2. Service-level tenant and child-parent isolation tests.
3. Role matrix and same-origin mutation tests.
4. Idempotency, concurrent submission, partial-failure, and amendment tests.
5. Comparability/statistical-policy fixtures and historical replay tests.
6. Required-auth browser coverage across desktop and mobile.
7. Postgres readiness before multi-instance deployment.
