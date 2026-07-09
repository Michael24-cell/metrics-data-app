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
```

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
