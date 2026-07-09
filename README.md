# TraceLab — Force & Training Intelligence (V1)

A performance analytics platform for force-plate and training data, built for strength coaches and performance staff. **Non-medical by design**: it displays measured data, trends, practitioner-defined criteria status, and human-reviewed context. It does not diagnose, predict injuries, provide medical advice, or make clearance decisions.

## Run it

```bash
npm install
npm run db:seed   # builds data/tracelab.db through the real import pipeline
npm run dev       # http://localhost:3000
npm test          # 24 deterministic calculation-engine tests
```

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`).

## Controlled demo mode — no authentication

This build has **no user login, no session identity, and no role-based access control**. Facility scoping is enforced at every database query (see `src/lib/db/dal.ts`), but *which* facility a visitor is scoped to is chosen by an unauthenticated cookie, guarded only by a confirmation interstitial (`src/app/api/facility/route.ts`) — a bare link can no longer silently switch facilities, but there is no login preventing anyone with the URL from doing so deliberately. A warning banner is shown on every page for the same reason.

**Until real authentication is built, this app should only be shown by the founder, in a setting they control (screen-shared or on their own machine) — never deployed as a self-serve public link.** Treat every current facility/athlete as demo or synthetic content; see `docs/DATA_GOVERNANCE.md`.

## The working loop

seed/demo/manual data → canonical schema → versioned metric calculations → deterministic findings → dashboards → practitioner report. Same data layer end to end; the report cannot disagree with the dashboard.

Demo universe: two facilities (switcher in the top bar proves scoping), 8 Ridgeline athletes, and a flagship athlete with ten months of synthetic 1000 Hz waveforms computed through the real engine — pre-injury baseline, gap, and a staged return protocol with live criteria evidence.

## Status: operational / provisional / stubbed / blocked

| Status | What |
|---|---|
| **Fully operational** | Facility-scoped schema (all V1 entities) · CMJ impulse–momentum height, mRSI, eccentric braking impulse, peak propulsive force · IMTP peak/relative force + RFD 0–50/50–150/150–250 with interpretation labels · DJ RSI · Asymmetry Index & LSI · baseline deviation monitoring (benchmark + rolling band + 1/2/3-session escalation) · findings engine (5 categories, evidence refs, versioned) · synthetic-signal, generic-CSV, manual-entry, demo-dataset adapters (full 6-stage pipeline) · Roster/Triage, Athlete Overview, Session Detail w/ waveform drill-down, Athlete Progress, Practitioner Report (print-ready), Case Study, Import workbench, Docs · generic metric-config-driven trend chart with raw/smoothed (default raw) · persistent URL-backed filter bar · 12 facility-scoped API routes |
| **Partially operational** | VBT: velocity reps + load–velocity fits are stored and displayed, but only from seeded data (no device ingestion UI) · training-load context (session-RPE only) · permission records modeled and displayed logic-side, but no auth/consent flows |
| **Stubbed / provisional** | Force–velocity profile (needs multi-load protocol) · load–velocity 1RM extrapolation intentionally withheld · vendor API adapters (interface-defined, throw `AdapterNotOperationalError`) · ExternalTestResult (schema-only, future-ready) |
| **Blocked until real data/keys** | Live vendor force-plate/VBT integrations (API agreements + credentials) · real athlete case study (requires written consent) · validated F–V references |

## Docs

`docs/METHODOLOGY.md` · `docs/DATA_GOVERNANCE.md` · `docs/ARCHITECTURE.md` · `docs/ROADMAP.md` · `docs/EVALS.md` — also rendered in-app at `/docs`.
