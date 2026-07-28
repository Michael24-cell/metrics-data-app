# TraceLab — Force & Training Intelligence (V1)

A performance analytics platform for force-plate and training data, built for strength coaches and performance staff. **Non-medical by design**: it displays measured data, trends, practitioner-defined criteria status, and human-reviewed context. It does not diagnose, predict injuries, provide medical advice, or make clearance decisions.

## Run it

```bash
npm install
npm run db:seed   # builds data/tracelab.db through the real import pipeline
npm run dev       # http://localhost:3000
npm test          # calculation-engine + intelligence-agent test suites
```

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`).

Optional live AI mode: `cp .env.example .env.local` and set `ANTHROPIC_API_KEY` (server-side only; git-ignored). Without a key the Intelligence Agent runs in deterministic scripted mode — the demo is fully functional offline. `npm run agent:smoke` is an optional manual live smoke test (one real model call; never run in CI).

## Authentication modes

`TRACELAB_AUTH_MODE=required` uses invitation activation, scrypt passwords,
opaque database sessions, memberships, and server-enforced roles. Production
always requires this mode and a 32+ character `TRACELAB_SESSION_SECRET`.
`TRACELAB_AUTH_MODE=demo` is an explicit local-development mode with a visible
warning and synthetic admin context; it is forbidden in production. Treat
every seeded athlete as synthetic; see `docs/DATA_GOVERNANCE.md`.

## The working loop

seed/demo/manual data → canonical schema → versioned metric calculations → deterministic findings → dashboards → practitioner report. Same data layer end to end; the report cannot disagree with the dashboard.

Demo universe: two facilities (switcher in the top bar proves scoping), 8 Ridgeline athletes, and a flagship athlete with ten months of synthetic 1000 Hz waveforms computed through the real engine — reference baseline, training interruption, and a staged progression protocol with live criteria evidence. Every athlete, timeline, and note is invented for the demo; none corresponds to a real person.

## Athlete Intelligence Agent (`/agent`)

An evidence-explanation layer on top of the deterministic engine. It generates a structured, claim-based report (and answers 7 focused questions — it is deliberately **not** an open chatbot) where **every claim carries resolvable evidence references** into the same rows the dashboard shows, gated by a comparability check and a deterministic post-generation safety evaluation (pass/warn/fail). A coach then approves, edits (the original generated report is always preserved), rejects, or marks needs-more-data — the model never writes its own approval.

Three honestly-named AI modes:

| Mode | What it actually is |
|---|---|
| `scripted` (default, no key) | Deterministic tool workflow over the current synthetic data — same tools and evidence contract as live, composed by code, not a model, and not a replay of a captured model run |
| `live` | Real Anthropic model tool-calling (server-side key, request timeouts, hard tool-step max, structured-output validation; any failure falls back safely to scripted — the page never crashes) |
| `fixture` | Frozen test expectations used by the test suite |

The Action & Evidence Trace shows tool calls, validated inputs, result summaries, evidence IDs, durations, and statuses — never model chain-of-thought. Runs, review records, and feedback persist server-side and are tenant-scoped. Browser storage is only a transient recent-run cache.

## Status: operational / provisional / stubbed / blocked

| Status | What |
|---|---|
| **Fully operational** | Facility-scoped schema (all V1 entities) · CMJ impulse–momentum height, mRSI, eccentric braking impulse, peak propulsive force · IMTP peak/relative force + RFD 0–50/50–150/150–250 with interpretation labels · DJ RSI · Asymmetry Index & LSI · baseline deviation monitoring (benchmark + rolling band + 1/2/3-session escalation) · findings engine (5 categories, evidence refs, versioned) · synthetic-signal, generic-CSV, manual-entry, demo-dataset adapters (full 6-stage pipeline) · Roster/Triage, Athlete Overview, Session Detail w/ waveform drill-down, Athlete Progress, Practitioner Report (print-ready), Case Study, Import workbench, Docs · generic metric-config-driven trend chart with raw/smoothed (default raw) · persistent URL-backed filter bar · 12 facility-scoped API routes |
| **Partially operational** | VBT: velocity reps + load–velocity fits are stored and displayed, but only from seeded data (no device ingestion UI) · training-load context (session-RPE only) · permission records modeled and displayed logic-side, but no auth/consent flows |
| **Stubbed / provisional** | Force–velocity profile (needs multi-load protocol) · load–velocity 1RM extrapolation intentionally withheld · vendor API adapters (interface-defined, throw `AdapterNotOperationalError`) · ExternalTestResult (schema-only, future-ready) |
| **Blocked until real data/keys** | Live vendor force-plate/VBT integrations (API agreements + credentials) · real athlete case study (requires written consent) · validated F–V references |

## Docs

`docs/METHODOLOGY.md` · `docs/DATA_GOVERNANCE.md` · `docs/ARCHITECTURE.md` · `docs/ROADMAP.md` · `docs/EVALS.md` — also rendered in-app at `/docs`.
