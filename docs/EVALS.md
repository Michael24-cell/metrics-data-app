# Evals & QA

## Principle

Every number a coach sees must be reproducible from stored data plus a versioned method. QA therefore focuses on (1) calculation correctness against known ground truth, (2) rule correctness against constructed scenarios, and (3) end-to-end pipeline integrity.

## Calculation engine tests (automated, `npm test`)

Synthetic force-time signals are generated with known ground truth (target takeoff velocity, known peak net force, known contact/flight times), then the engine must recover those values:

- CMJ impulse–momentum height within tolerance of `v²/2g` for the constructed takeoff velocity; mRSI equals height ÷ time-to-takeoff exactly.
- Strategy sensitivity: deeper countermovement lowers mRSI at equal jump height.
- IMTP: BW recovery from quiet standing, peak ≈ BW + constructed net force, RFD window ordering for exponential rises, faster rise ⇒ higher early RFD.
- Onset detection refuses flat/noise-only trials (throws, never fabricates).
- Asymmetry formula matches the specified default formula to 3+ decimals and is symmetric in its arguments; LSI validates inputs.
- Baseline monitoring: insufficient-baseline reporting, 1/2/3-consecutive escalation, reset behavior, band symmetry.
- Determinism: identical seeds produce identical results.
- Sanity ranges flag implausible values.

24 tests at time of writing; all must pass before seed or deploy.

## Findings-engine scenario checks (seeded, verified each reseed)

The demo seed constructs athletes as living test fixtures, and the expected finding must appear:

| Scenario athlete | Expected outcome |
|---|---|
| Stable athlete + 2 sharply low sessions after a heavy block | `below_band` then `mandatory_deload`, each annotated by a `training_context_note` that does not downgrade them |
| Growing per-side braking drift, stable output | `asymmetry_flag` (flag ≥ facility threshold) on braking impulse only |
| Athlete on active protocol | `rts_stage_status` with per-criterion met/not-met/insufficient evidence; **no** general asymmetry flags (non-overlap rule) |
| 4-session newcomer | `data_gap` (baseline not established), no deviation claims |
| No testing >14 days | `data_gap` recency watch |
| Metric-only import without sides | `data_gap` (asymmetry not assessable) |

## Pipeline integrity

- CSV/manual/demo imports run inspect→validate before any write; invalid athlete or facility references fail validation with explicit messages.
- Unscoreable trials record their failure reason on the trial and appear in the batch summary.
- Facility isolation: switching facility must change every roster, finding, and import surface with zero leakage (manually verified with the two seeded facilities).

## Not yet automated (known QA debt)

- UI snapshot/interaction tests (raw/smoothed toggle, filters) — currently manual.
- Findings scenario table above is verified by inspection after seeding — should become an automated integration test against the seeded DB.
- Report/print layout regression checks.
