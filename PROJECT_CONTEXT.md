# Project context — TraceLab + Athlete Intelligence Agent

One-page orientation for anyone (human or AI) picking up this repo. Deeper detail: `README.md`, `docs/ARCHITECTURE.md`, `docs/METHODOLOGY.md`, `docs/EVALS.md`, `docs/DATA_GOVERNANCE.md`, `docs/ROADMAP.md`.

## What this is

A force-plate + training analytics platform for strength coaches, with an additive AI layer (the **Athlete Intelligence Agent**, `/agent`) that explains the deterministic engine's evidence. **Non-medical by design**: no diagnosis, no injury prediction, no clearance or return-to-play decisions — evidence for the coach, never a verdict. All data is synthetic; every athlete, timeline, protocol, and note is invented for the demo.

## Hard boundaries (do not relax)

- **Non-medical language everywhere** — internal keys like `rts_stage_status` may exist for schema stability, but user-facing labels are non-medical ("Progression criteria status"), and the agent's eval layer fails any output containing diagnosis/clearance/prediction/medical framing.
- **Deterministic core, explanatory AI** — metrics and findings are computed by versioned deterministic code. The agent only *retrieves and explains* through 13 read-only tools; it never recalculates or writes.
- **Every claim is evidence-bound** — claims carry resolvable evidence references; a deterministic evaluation (schema, prohibited language, numeric fidelity, comparability, scope) gates what the UI shows.
- **Server-only secrets** — `ANTHROPIC_API_KEY` is read from env server-side only; `.env*` is git-ignored; without a key the agent runs in deterministic scripted mode.
- **Untrusted text stays data** — practitioner notes and import content are quoted, never followed as instructions.
- **Controlled demo scoping, not auth** — every query is facility-scoped in the DAL and agent tools are athlete+facility-bound at creation, but the active facility comes from an unauthenticated cookie. This is demo scoping; there is no production authentication or tenant isolation yet. Founder-driven demos only.

## Agent modes (honest names)

`fixture` = frozen test expectations · `scripted` = deterministic tool workflow over current synthetic data (keyless default; not a "replay") · `live` = real Anthropic model tool-calling with timeouts, step caps, structured-output validation, and safe fallback to scripted. Runs/reviews persist client-side (localStorage); route handlers are stateless; the original generated report is never mutated by an edit.

## Key seams

- `src/lib/agent/` — schemas, tools, comparability gate, evals, scripted composer, live adapter, diff, runner, scenario dataset, tests.
- `src/lib/config/metrics.ts` — the metric registry (exact structured retrieval source for the agent's methodology tool).
- `src/lib/db/dal.ts` — all data access, facility-scoped by construction.
- `scripts/seed.ts` — the synthetic demo universe; reseed with `npm run db:seed` after changing it.

## Status

V1 vertical slice + agent layer complete and tested (`npm test`). Live vendor integrations, real authentication, and real-athlete data remain out of scope until agreements, auth, and consent exist — see the status table in `README.md` and `docs/ROADMAP.md`.
