# Methodology

TraceLab computes every displayed value with deterministic, versioned functions. There is no machine learning, no LLM, and no statistical inference beyond what is documented here. If a value cannot be computed responsibly, the platform reports a data gap instead.

## Scope statement

This platform describes measured data and trends. It does not diagnose, predict injury, or clear an athlete to return to play. Those decisions remain with the athlete's qualified clinical and performance team.

## Signal processing conventions

- Force-plate trials are captured at the device rate (1000 Hz for the demo device) and computed at full rate. A downsampled (250 Hz) copy is stored for display only.
- **Body weight (BW)**: mean vertical force during the first 1.0 s of quiet standing. The standard deviation (SD) of that window defines the noise floor.
- **Onset / movement start**: force deviates from BW by more than 5 × quiet-SD, sustained ≥ 20 ms. This threshold is part of the method version; changing it bumps the version.
- **Smoothing** (charts): centered 5-session moving average, display-only, default **off** (raw). Smoothed values never feed calculations or findings.

## Metrics

Source status is one of: **practitioner-defined / standard convention** (a widely used sports-science method, implemented here per this platform's own documented formula — no specific external citation is asserted), or **provisional** (scaffolded, not yet backed by a validated reference). No metric in this build is labeled "published" — the codebase does not carry a verified citation for any formula, and none is invented here. If a facility has a specific published source they want attributed to a metric, it can be added to this table once supplied.

| Metric | Formula | Unit | Method version | Sanity range | Source status |
|---|---|---|---|---|---|
| IMTP peak force | Max net force after onset. Per-side values read at the instant of total peak. | N | 1.0.0 | 800–9000 | practitioner-defined / standard convention |
| IMTP relative force | Peak force ÷ body mass | N/kg | 1.0.0 | 10–70 | practitioner-defined / standard convention |
| RFD 0–50 ms | (F(50ms) − F(onset)) / 0.05 s | N/s | 1.0.0 | 500–30000 | practitioner-defined / standard convention |
| RFD 50–150 ms | (F(150ms) − F(50ms)) / 0.10 s | N/s | 1.0.0 | 500–30000 | practitioner-defined / standard convention |
| RFD 150–250 ms | (F(250ms) − F(150ms)) / 0.10 s | N/s | 1.0.0 | 300–25000 | practitioner-defined / standard convention |
| CMJ jump height | Impulse–momentum: net impulse from movement start to takeoff → takeoff velocity v; h = v²/2g. Not flight-time based. | cm | 1.0.0 | 5–70 | practitioner-defined / standard convention |
| mRSI | Jump height (m) ÷ time from movement start to takeoff (s) | m/s | 1.0.0 | 0.1–1.2 | practitioner-defined / standard convention |
| Eccentric braking impulse | ∫(F − BW)dt from peak negative velocity to zero velocity. Per-side against BW/2 (bilateral stance assumption). | N·s | 1.0.0 | 10–400 | practitioner-defined / standard convention |
| CMJ peak propulsive force | Peak vertical GRF during the propulsive phase | N | 1.0.0 | 500–8000 | practitioner-defined / standard convention |
| Drop jump RSI | Flight time ÷ ground contact time (threshold crossings at 20 N) | ratio | 1.0.0 | 0.3–4.0 | practitioner-defined / standard convention (see [mRSI vs RSI](#mrsi-vs-rsi) — this platform uses flight-time ÷ contact-time, one of two conventions used in the field) |
| Asymmetry Index | abs(stronger − weaker) ÷ (0.5 × (stronger + weaker)) × 100, from session-best per-side values | % | 1.0.0 | 0–60 | practitioner-defined / standard convention |
| LSI | involved ÷ uninvolved × 100. Used only where an injury record defines an involved side. | % | 1.0.0 | — | practitioner-defined / standard convention |
| Load–velocity profile slope | Least-squares slope of load vs mean concentric velocity | (m/s)/kg | 0.1.0-provisional | −0.05–0 | provisional |
| Force–velocity profile slope | Linear F–V fit across loaded jumps | N·s/m/kg | 0.1.0-provisional | −60–0 | provisional |

## Interpretation labels

Wherever these metrics appear, the platform shows the associated interpretation, not just the number. Wording is kept educational and performance-oriented — it does not overclaim physiology or promise training outcomes:

- **RFD 0–50 ms** — early rapid force onset; reflects neural recruitment speed — how quickly the nervous system switches force on. Trainable with ballistic/plyometric work.
- **RFD 50–150 ms** — mid-phase force development. Influenced by neuromuscular qualities and fiber-type profile; presented as interpretation, not a fixed ceiling — it typically responds more slowly to training than the 0–50 ms window, not that it can't respond at all.
- **RFD 150–250 ms** — later force development, more dependent on muscle cross-sectional area and maximal strength; trainable with heavy resistance work.
- **mRSI** — reveals jump strategy (deep/force-reliant vs reflexive/stretch-shortening-reliant), independent of jump height. See [mRSI vs RSI](#mrsi-vs-rsi).
- **Eccentric braking impulse** — a force-absorption / deceleration measure relevant to change-of-direction capacity. Not a movement-quality assessment, and not a diagnosis, injury-prediction, or clearance metric.

### mRSI vs RSI

These are two different formulas, computed from two different test types, and are not interchangeable:

- **mRSI** (from a countermovement jump) = jump height ÷ time to takeoff. It describes whether an athlete is relying on a longer/deeper countermovement (force-reliant) strategy versus a faster stretch-shortening-cycle (reflexive) strategy at a given jump height.
- **RSI** (from a drop jump, this platform's `dj_rsi`) = flight time ÷ ground contact time.

Note on field terminology: some published sources define drop-jump RSI as jump height ÷ ground contact time rather than flight time ÷ contact time. Both are used in practice by different vendors and labs; they are related but not numerically identical. This platform implements flight time ÷ contact time. If your facility standardizes on the jump-height-based definition, treat `dj_rsi` values as this platform's specific convention rather than a universal figure, and do not average or compare them directly against RSI values computed elsewhere with the other convention.

## Baseline deviation monitoring (v1.0.0) — CMJ autoregulation protocol

- **Benchmark period**: 15 or 30 sessions (default 20) before establishing a baseline mean + SD. Below 15 sessions the metric is *not monitored* and a data-gap finding says so instead of guessing.
- **Rolling window**: last 5 sessions, recalculated every session.
- **Normal band**: rolling_mean ± 1 SD (rolling-window SD once the window is full; benchmark SD before that).
- **1 below-band session**: review / autoregulate training **volume** (not intensity).
- **2 consecutive below-band sessions**: deload recommendation (mandatory deload flag).
- **3+ consecutive below-band sessions**: elevated attention / review flag.

These are plain, measured-deviation flags. No injury-risk multiplier is attached to any of them, and none of them implies injury prediction — by design.

## Staged progress criteria

Athletes on an active, practitioner-defined return-to-sport protocol (`RTSProtocol` / `RTSStage`) are evaluated against **staged criteria/evidence only** — never displayed as clearance, diagnosis, or a return-to-play decision. Each criterion is shown as one of:

- **criterion met** / **not yet met** — computed from this platform's metric data against a practitioner-set numeric target.
- **insufficient data** — the platform tried to evaluate it and doesn't have enough sessions or per-side data yet.
- **documented separately** — a practitioner-attested item (e.g. range of motion, pain/swelling, a test this platform does not compute, such as a hop test or isolated plantarflexor strength). These are never merged into the computed met/total count and are never treated as "insufficient data," since the platform was never going to compute them.

The demo protocol (see `scripts/seed.ts`) uses a 4-stage framework:

| Stage | Progression | Example computed criteria | Example practitioner-attested (context) criteria |
|---|---|---|---|
| 1 | ~50% running progression | MVIC LSI ≥70% (IMTP peak force LSI) | Hop test ≥70%; pain-free weight-bearing, no swelling |
| 2 | ~75% running progression | MVIC LSI 80–85% (IMTP peak force LSI); CMJ jump height ≥75% of pre-injury baseline | Full passive range of motion |
| 3 | Plyometric / jumping progression | Eccentric braking impulse LSI ≥90%; IMTP peak force LSI ≥90%; CMJ jump height ≥90% of baseline; drop jump RSI ≥2.0 | Plantarflexor LSI ≥80%; full pain-free range of motion |
| 4 | Sprint / cutting / full progression | Eccentric braking impulse LSI ≥95%; CMJ jump height ≥95% of baseline; IMTP peak force LSI ≥90% | Full symmetric range of motion; no pain; no swelling |

**Sourcing note (read this before citing these numbers externally):** "MVIC" (maximum voluntary isometric contraction) is evaluated using this platform's existing IMTP peak force LSI calculation — an isometric mid-thigh pull *is* an MVIC test, so this is a relabeling of an already-computed criterion, not a new metric. Hop test and plantarflexor strength have no computed backing in this platform (no protocol, device, or adapter for either exists in V1) and are always recorded as practitioner-attested context. The general shape of this framework (graded running → strength → plyometric → sprint/cutting progression, with increasing LSI/symmetry thresholds per stage) reflects **common return-to-sport staging conventions used across the field**; no single external publication is asserted as the source for the specific numeric thresholds above, and none should be inferred from this document. Stages 1, 2, and 4 are not attributed to the same source as stage 3 or to each other — all are labeled practitioner-defined, per clinical/performance team guidance for this facility. If a facility wants to cite a specific published protocol for any stage, that citation should be added explicitly rather than assumed.

## Force–velocity profiling protocol (planned, provisional)

Not implemented in V1 — documented here as the intended data-collection protocol for when a multi-load jump testing session becomes available (see `FV_PROFILE_PROTOCOL` in `src/lib/calc/profiles.ts`):

- **CMJ loaded series**: bodyweight, +10%, +20%, +30%, +40%.
- **Squat jump loaded series**: bodyweight, +20%, +40%, +60%, +80%.

This series would feed an optimal-power-load and force-velocity profile. Classification language (e.g. "force-deficient" / "velocity-deficient") is intentionally not implemented or displayed — it remains provisional until a validated reference profile is added. No such classification is invented as trusted output in this build.

## VBT / load–velocity profile protocol (planned, provisional)

Documented here as the intended data-collection protocol (see `LVP_PROTOCOL` in `src/lib/calc/profiles.ts`); `fitLoadVelocityProfile()` itself accepts whatever load/velocity pairs it is given and does not enforce this protocol:

- **Loads**: 30%, 50%, 70%, 80% of 1RM.
- **Reps**: 3 per load.
- **Progression rule**: increase load by 5% once mean velocity improves by **≥ 0.06 m/s** for two consecutive sessions at the same load.

The 0.06 m/s threshold is deliberately set above the assumed device standard error, so a "velocity improved" reading reflects a real change rather than measurement noise. Do not lower this to 0.05 m/s without new evidence that device error is smaller than assumed. Prescription and 1RM-extrapolation language remain provisional until validated references are added — none is derived or displayed in this build.

## Findings

Findings are generated by a deterministic rules engine (v1.0.0) in five categories: `baseline_deviation`, `rts_stage_status`, `asymmetry_flag`, `training_context_note`, `data_gap`. Rules:

- Every finding carries references: metric type, method version, threshold key/version, protocol/stage version, and the sessions involved.
- Training context **annotates** a finding; it never suppresses or downgrades one.
- **General-athlete asymmetry monitoring and staged-criteria matching are two different concepts, kept structurally separate**: `asymmetry_flag` monitors any currently-training athlete against facility-wide watch/flag thresholds; `rts_stage_status` evaluates an athlete on a documented recovery/progress pathway against practitioner-defined stage criteria. They are different claims, different populations, and different purposes, so an athlete with an active RTS protocol gets criteria evidence only — never a general asymmetry flag — and the two rules are never merged into one generic asymmetry system.
- Stage criteria are always displayed as met / not yet met / insufficient data / documented separately per criterion — never aggregated into a readiness verdict.
- Insufficient data produces a data-gap finding; the platform never extrapolates through missing data.

## Sanity ranges & quality flags

Every metric has a plausible physiological range in the registry. Out-of-range values are stored but quality-flagged and visibly labeled; they are never silently dropped or corrected. Unscoreable trials (e.g., no detectable onset) are recorded with the failure reason.

## Method versioning

Method versions are semver strings stored on every metric row. Any change to a formula, threshold, window, or detection constant bumps the version, so historical values remain attributable to the method that produced them.
