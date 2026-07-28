# Architecture

## Stack

- **Next.js 15 (App Router, TypeScript)** — server components read the DAL directly; API routes expose the same services as JSON.
- **SQLite via `node:sqlite`** — zero-dependency embedded store (`data/tracelab.db`), WAL mode. The schema is plain SQL; swapping to Postgres later changes the DAL, not the domain code.
- **No chart library** — charts are hand-rolled SVG components, parameterized by metric config.
- **Vitest** — deterministic tests for the calculation engine.

## Layers

```
adapters (synthetic / CSV / manual / demo / vendor stubs)
        │  inspect → map_to_canonical → validate → import_raw → compute_metrics → generate_outputs
        ▼
canonical schema (facility-scoped: athlete, session, trial, metric, …)
        ▼
calculation engine (deterministic, versioned: cmj, imtp, dj, asymmetry, baseline, profiles)
        ▼
findings engine (rules, versioned; 5 categories, evidence references)
        ▼
services (roster, trends, asymmetry, baseline, report builder)
        ▼
surfaces (Roster, Athlete Overview, Session Detail, Progress, Report, Story, Import)
   and API routes (/api/…) — same services, same data
        ▼
intelligence agent (src/lib/agent) — read-only tools over the layers above;
   explains evidence, never recalculates or decides
```

## Intelligence agent (`src/lib/agent`)

A four-stage, stateless, server-side workflow (`runner.ts`):

1. **Deterministic intake** — scope check, data-completeness snapshot, input snapshot hash.
2. **One bounded Evidence Agent** — 13 read-only tools (`tools.ts`), each zod-validated and bound to a single facility + athlete at executor creation (tool inputs cannot name an athlete or facility). In `scripted` mode a deterministic composer (`scripted.ts`) runs the tools; in `live` mode a real model does (`live.ts`: server-only key, per-request timeout + total AbortController deadline, hard tool-step max, structured submit-tool output validated with zod, injectable transport for mocked contract tests, any failure → safe fallback to scripted).
3. **Deterministic post-generation evaluation** (`evals.ts`) — 10 checks (schema, prohibited language, evidence presence/resolvability/scope, numeric fidelity against cited evidence, comparability enforcement, baseline distinction, quality disclosure, no verdict aggregation) → pass/warn/fail gates the UI.
4. **Human review** — approve / edit / reject / needs-more-data in the UI; edits create a separate server-side, tenant-scoped review row and the original generated report is never mutated. Runs, reviews, and feedback persist in SQLite; browser storage is only a transient recent-run UI cache.

Key contracts: deterministic claim IDs (`claims.ts` — sha256 of claim type + metric + comparison window + sorted evidence IDs, so report diffs stay stable when wording changes), a comparability gate (`comparability.ts` — no trend narration across mixed test types/method versions/devices/units), a report differ keyed on claim identity (`diff.ts`), and an evidence resolver (`evidence.ts`) that resolves every citable ID within the athlete's scope for the evidence explorer. Practitioner notes are treated as untrusted text: quoted as data, never followed as instructions. The trace shown in the UI contains tool calls, inputs, results, and durations — never model chain-of-thought.

Mode names are honest: `fixture` = frozen test expectations; `scripted` = deterministic tool execution over current synthetic data (not a "replay" of anything); `live` = real model tool calling. A future `replay` mode would mean captured, sanitized live runs — it does not exist yet and nothing is labeled that way.

## Key decisions

- **One pipeline for every data path.** Manual entry, CSV, demo datasets, and synthetic signals all pass through the same six adapter stages into the same canonical tables, so downstream code has exactly one shape of data.
- **Facility scoping in the DAL.** Every DAL function takes `facilityId` and filters in SQL. Pages and routes cannot forget to scope because there is no unscoped function to call.
- **Config-driven metric registry.** `src/lib/config/metrics.ts` defines identity, units, precision, sanity ranges, interpretation text, sidedness, and method version for each metric. UI components (including the generic trend chart) read from this registry; adding a metric = registry entry + calculation function.
- **Metrics are immutable facts.** Computed once at import with a method version. Recomputation (e.g., after a method bump) would write new rows under the new version — history stays attributable.
- **Findings are a projection.** Deleted and regenerated per athlete from current data; they can always be reproduced and never disagree with the metrics they cite.
- **Waveforms**: computed at full rate in memory during import; a 250 Hz display copy is stored on the trial for drill-down. This keeps the DB small without compromising calculation fidelity.
- **Report = dashboard.** The practitioner report renders the same service outputs (`buildReport` composes the same queries) — there is no second calculation path to diverge.

## Entities (V1)

Facility, Athlete, Device, DataSource, ImportBatch, PermissionRecord, Session, Trial, Metric, ThresholdSetting, InjuryRecord, RTSProtocol, RTSStage, ClinicalAssessment, Finding, TrainingSession, ExerciseSet, VelocityRep, LoadVelocityProfile, Milestone, and **ExternalTestResult** (schema-only, future-ready; no ingestion or findings logic touches it in V1).

## Extension points

- **Vendor adapters**: implement the `Adapter` interface (six stages). Stubs for three vendor APIs exist and throw `AdapterNotOperationalError` until credentials/agreements exist.
- **New metrics**: registry entry + calculation in `computeTrialMetrics` (or an imported metric type for metric-only sources).
- **New finding rules**: pure functions in the findings engine; bump `FINDINGS_ENGINE_VERSION`.
- **Thresholds**: `threshold_setting` rows are facility-scoped and versioned; finding references carry the version used.
