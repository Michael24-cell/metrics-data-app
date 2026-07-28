# Test Protocol Platform — future design

Status: design only. This document does not authorize implementation or claim
that protocol execution is available in the current product.

## Purpose

Provide a versioned, tenant-scoped way for administrators and coaches to
define test protocols, assign them to athletes or teams, capture execution
context, validate comparable observations, and hand accepted results to the
existing deterministic calculation and monitoring systems.

## Domain model

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

Every athlete-bearing row carries `facility_id`; foreign keys and service
queries validate the facility, athlete, assignment, execution, and child row
together. Browser-provided facility IDs are never authoritative.

## Lifecycle

`draft → reviewed → published → retired`. Published versions are immutable.
Assignments reference a published version. Executions progress
`planned → in_progress → submitted → accepted|rejected`; only accepted results
enter analytics. Interrupted work is resumable through idempotent,
server-issued submission keys.

## Authorization

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

## API outline

- Read definitions/versions/assignments through tenant-scoped services.
- Create drafts and publish with `If-Match`/version checks.
- Start an execution server-side; never accept facility ownership from input.
- Submit step results with idempotency keys and bounded payloads.
- Accept/reject through append-only review records.
- Export only accepted data through `exports.create`, with audit events.

## Rollout gates

1. Schema migration and rollback/restore rehearsal.
2. Service-level tenant and child-parent isolation tests.
3. Role matrix and same-origin mutation tests.
4. Idempotency, concurrent submission, partial-failure, and amendment tests.
5. Comparability/statistical-policy fixtures and historical replay tests.
6. Required-auth browser coverage across desktop and mobile.
7. Postgres readiness before multi-instance deployment.
