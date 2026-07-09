# Data Governance

## What this platform is — and is not

TraceLab is a **non-medical performance analytics product** for strength coaches and performance staff. It displays measured performance data, trends, practitioner-defined criteria status, and human-reviewed context.

It does **not**:

- diagnose injuries or medical conditions,
- predict injuries or produce risk scores,
- provide medical advice,
- make or imply return-to-play clearance decisions.

Every report carries this statement near the top and in the footer: *"This report describes measured data and trends. It does not diagnose, predict injury, or clear an athlete to return to play. Those decisions remain with the athlete's qualified clinical and performance team."*

## Facility scoping

Every athlete, session, trial, metric, finding, import batch, threshold, and permission record carries a `facility_id`. The data-access layer requires a facility on every query — there is no unscoped code path for athlete data. Imports validate athlete ownership: rows referencing another facility's athletes are rejected at validation, not silently imported. One facility cannot see, or write into, another facility's data.

## Data categories and minimization

| Category | Stored | Notes |
|---|---|---|
| Identity | Display name, team, position, birth year | No government IDs, no contact details in V1. |
| Anthropometrics | Height, mass | Needed for relative metrics. |
| Performance signals | Force-time waveforms, computed metrics | Full-rate signals used at compute time; downsampled copies stored for display. |
| Injury records | Practitioner-entered label, side, dates | Deliberately minimal: enough to organize performance data. Clinical detail stays in clinical systems. |
| Clinical assessments | Human-authored summaries, displayed verbatim | The platform never generates clinical text. |
| Permission records | Scope, grantor, dates | See below. |

## Permissions

Each athlete has permission records with explicit scopes (`performance_monitoring`, `report_sharing`, `demo_display`). The demo case study is gated on a `demo_display` scope and uses placeholder identity and synthetic data. Revocation is modeled (`revoked_at`); revoked scopes exclude the athlete from the corresponding surface.

## Provenance

Every session traces to an import batch, its adapter, and (where applicable) a device with sampling rate and calibration date. Metric rows record their source (`computed` / `imported` / `manual`) and method version, so any number on any surface can be traced to how it was produced.

## Findings integrity

- Findings are regenerated deterministically from current data; they cannot drift from the metrics they cite.
- Training context can annotate a finding but structurally cannot suppress or downgrade it.
- Data gaps are first-class findings: absence of data is reported as absence, never smoothed over.

## Demo data disclosure

All seeded athletes, facilities, and signals in this build are synthetic. Names are invented; waveforms are generated. Anything presented as a "case study" is placeholder content and labeled as such in the UI.
