/**
 * Demo seed. Deletes and rebuilds data/tracelab.db.
 *
 * Everything flows through the real adapter pipeline
 * (inspect → map → validate → import_raw → compute_metrics → generate_outputs):
 * - synthetic force-time waveforms at 1000 Hz for force-plate athletes
 * - a CSV import (sided IMTP values) for one athlete
 * - a manual entry session
 * - a bundled demo-dataset import (metric-only, no per-side data)
 * Metrics in the DB are COMPUTED by the calc engine, not hardcoded.
 */

import fs from "node:fs";
import path from "node:path";

const dbPath = path.join(process.cwd(), "data", "tracelab.db");
if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
for (const suffix of ["-wal", "-shm", "-journal"]) {
  if (fs.existsSync(dbPath + suffix)) fs.rmSync(dbPath + suffix);
}

import { getDb, newId, nowIso } from "../src/lib/db/db";
import { generateCmjTrace, generateImtpTrace, generateDjTrace, rng } from "../src/lib/calc/synthetic";
import {
  syntheticSignalAdapter,
  csvGenericAdapter,
  manualEntryAdapter,
  demoDatasetAdapter,
  vendorStubs,
  runImportBatch,
  SyntheticInput,
} from "../src/lib/pipeline/adapters";


const db = getDb();
const now = nowIso();

/** Demo clock: "today" for the demo universe. */
const TODAY = "2026-07-09";

const addDays = (iso: string, days: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/* ---------------- facilities ---------------- */

const RPI = newId();
const HCFC = newId();
db.prepare(`INSERT INTO facility (id, name, short_name, created_at) VALUES (?, ?, ?, ?)`).run(
  RPI, "Ridgeline Performance Institute", "Ridgeline", now
);
db.prepare(`INSERT INTO facility (id, name, short_name, created_at) VALUES (?, ?, ?, ?)`).run(
  HCFC, "Harbor City FC", "Harbor City", now
);

/* ---------------- devices ---------------- */

function addDevice(facilityId: string, deviceType: string, make: string, model: string, hz: number | null) {
  const id = newId();
  db.prepare(
    `INSERT INTO device (id, facility_id, device_type, make, model, sampling_hz, last_calibrated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, facilityId, deviceType, make, model, hz, "2026-06-15", now);
  return id;
}
const rpiPlate = addDevice(RPI, "dual_force_plate", "Axiom", "FD-2 Dual Plate", 1000);
const rpiLpt = addDevice(RPI, "linear_transducer", "PushPull", "LT-1", null);
addDevice(RPI, "manual", "—", "Manual entry", null);
const hcfcPlate = addDevice(HCFC, "dual_force_plate", "Axiom", "FD-2 Dual Plate", 1000);

/* ---------------- data sources (incl. stubs) ---------------- */

function addSource(facilityId: string, adapterKey: string, label: string, kind: string) {
  const id = newId();
  db.prepare(
    `INSERT INTO data_source (id, facility_id, adapter_key, label, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, facilityId, adapterKey, label, kind, now);
  return id;
}
const srcSynthetic = addSource(RPI, "synthetic_signal", "Force Plate Capture (demo signals)", "operational");
const srcCsv = addSource(RPI, "csv_generic", "Generic CSV Mapper", "operational");
const srcManual = addSource(RPI, "manual_entry", "Manual Entry", "operational");
const srcDemo = addSource(RPI, "demo_dataset", "Public/Demo Dataset", "operational");
for (const stub of vendorStubs) addSource(RPI, stub.key, stub.label, "stub");
const srcSyntheticHc = addSource(HCFC, "synthetic_signal", "Force Plate Capture (demo signals)", "operational");

/* ---------------- thresholds ---------------- */

function addThreshold(facilityId: string, key: string, value: number, metricType: string | null = null) {
  db.prepare(
    `INSERT INTO threshold_setting (id, facility_id, key, metric_type, value, version, set_by, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 'Head of Performance', 1, ?)`
  ).run(newId(), facilityId, key, metricType, value, now);
}
addThreshold(RPI, "asymmetry_watch_pct", 10);
addThreshold(RPI, "asymmetry_flag_pct", 15);
addThreshold(HCFC, "asymmetry_watch_pct", 8);
addThreshold(HCFC, "asymmetry_flag_pct", 12);

/* ---------------- athletes ---------------- */

interface AthleteSpec {
  id: string;
  name: string;
  sport: string;
  position: string;
  team: string;
  sex: string;
  birthYear: number;
  heightCm: number;
  massKg: number;
  status: string;
}

function addAthlete(facilityId: string, a: AthleteSpec) {
  db.prepare(
    `INSERT INTO athlete (id, facility_id, display_name, sport, position, team, sex, birth_year, height_cm, mass_kg, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(a.id, facilityId, a.name, a.sport, a.position, a.team, a.sex, a.birthYear, a.heightCm, a.massKg, a.status, now);
  db.prepare(
    `INSERT INTO permission_record (id, facility_id, athlete_id, scope, granted_by, granted_at, notes)
     VALUES (?, ?, ?, 'performance_monitoring', 'athlete (signed facility agreement)', ?, NULL)`
  ).run(newId(), facilityId, a.id, now);
}

// Flagship demo athlete — fully invented adaptive athlete. Name, timeline,
// interruption category, and progression details are synthetic and generic by
// design: no real person, procedure, protocol, or classification is referenced.
const maya: AthleteSpec = { id: newId(), name: "Kai Solari", sport: "Adaptive Track & Field", position: "Sprint (adaptive)", team: "Adaptive Track", sex: "F", birthYear: 2002, heightCm: 178, massKg: 71, status: "rts" };
const tessa: AthleteSpec = { id: newId(), name: "Tessa Lindqvist", sport: "Volleyball", position: "Outside Hitter", team: "Women's Volleyball", sex: "F", birthYear: 2003, heightCm: 183, massKg: 68, status: "active" };
const dario: AthleteSpec = { id: newId(), name: "Dario Reyes", sport: "Soccer", position: "Fullback", team: "Men's Soccer", sex: "M", birthYear: 2001, heightCm: 176, massKg: 74, status: "active" };
const jonas: AthleteSpec = { id: newId(), name: "Jonas Verbeek", sport: "Rowing", position: "Stroke", team: "Men's Rowing", sex: "M", birthYear: 2000, heightCm: 192, massKg: 88, status: "active" };
const priya: AthleteSpec = { id: newId(), name: "Priya Shah", sport: "Track & Field", position: "100m/200m", team: "Women's Track", sex: "F", birthYear: 2004, heightCm: 165, massKg: 58, status: "active" };
const malik: AthleteSpec = { id: newId(), name: "Malik Thompson", sport: "Football", position: "Linebacker", team: "Football", sex: "M", birthYear: 2002, heightCm: 188, massKg: 104, status: "active" };
const elena: AthleteSpec = { id: newId(), name: "Elena Brooks", sport: "Basketball", position: "Forward", team: "Women's Basketball", sex: "F", birthYear: 2003, heightCm: 185, massKg: 78, status: "active" };
const sofia: AthleteSpec = { id: newId(), name: "Sofia Marchetti", sport: "Soccer", position: "Winger", team: "Women's Soccer", sex: "F", birthYear: 2005, heightCm: 168, massKg: 61, status: "active" };

for (const a of [maya, tessa, dario, jonas, priya, malik, elena, sofia]) addAthlete(RPI, a);

// Maya has an extra permission scope: her (anonymized-placeholder) case study display
db.prepare(
  `INSERT INTO permission_record (id, facility_id, athlete_id, scope, granted_by, granted_at, notes)
   VALUES (?, ?, ?, 'demo_display', 'athlete (written consent, demo placeholder)', ?, 'Case study uses placeholder identity and demo data only.')`
).run(newId(), RPI, maya.id, now);

const kofi: AthleteSpec = { id: newId(), name: "Kofi Mensah", sport: "Soccer", position: "Striker", team: "First Team", sex: "M", birthYear: 1999, heightCm: 181, massKg: 77, status: "active" };
const lucas: AthleteSpec = { id: newId(), name: "Lucas Ortega", sport: "Soccer", position: "Midfielder", team: "First Team", sex: "M", birthYear: 2001, heightCm: 174, massKg: 70, status: "active" };
for (const a of [kofi, lucas]) addAthlete(HCFC, a);

/* ---------------- injury / RTS protocol for Maya ---------------- */

const injuryId = newId();
db.prepare(
  `INSERT INTO injury_record (id, facility_id, athlete_id, label, involved_side, occurred_on, resolved_on, entered_by, notes, created_at)
   VALUES (?, ?, ?, ?, 'left', '2026-01-12', NULL, 'Performance staff', ?, ?)`
).run(
  injuryId, RPI, maya.id,
  "Lower-limb training interruption (generic demo category)",
  "Details of any training interruption are maintained by the athlete's own support team, outside this platform. This platform stores only a generic label, side, and dates needed to organize performance data. This demo record is fully synthetic.",
  now
);

const protocolId = newId();
db.prepare(
  `INSERT INTO rts_protocol (id, facility_id, athlete_id, injury_record_id, name, version, status, defined_by, created_at)
   VALUES (?, ?, ?, ?, 'Staged performance progression', 2, 'active', 'Performance staff', ?)`
).run(protocolId, RPI, maya.id, injuryId, now);

function addStage(
  stageNumber: number, name: string, description: string, status: string,
  enteredOn: string | null, completedOn: string | null, criteria: object[]
) {
  db.prepare(
    `INSERT INTO rts_stage (id, facility_id, protocol_id, stage_number, name, description, criteria_json, status, entered_on, completed_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId(), RPI, protocolId, stageNumber, name, description, JSON.stringify(criteria), status, enteredOn, completedOn);
}

// Staged-criteria framework below is a fully invented, practitioner-defined
// DEMO progression. It is generic by design: no real athlete's protocol, no
// published staging table, and no clinical decision framework is reproduced
// here. "MVIC LSI" criteria are evaluated against this platform's IMTP peak
// force LSI — an isometric mid-thigh pull is a maximum voluntary isometric
// contraction test, so this is a relabeling of an existing computed
// criterion, not a new metric. Items the platform cannot compute (hop test,
// movement comfort, range of motion) are recorded as kind:"context" —
// practitioner-attested evidence, never merged into computed criteria.
addStage(1, "Foundation re-loading", "Re-establish comfortable bilateral loading and baseline testing habits, per performance-staff guidance (illustrative demo stage).", "completed", "2026-03-02", "2026-04-19", [
  { id: "s1c1", label: "Tolerates bilateral CMJ testing (any height recorded)", metric_type: "cmj_jump_height", kind: "absolute", operator: ">=", target: 10, unit: " cm" },
  { id: "s1c2", label: "IMTP relative force", metric_type: "imtp_relative_force", kind: "absolute", operator: ">=", target: 20, unit: " N/kg" },
  { id: "s1c3", label: "MVIC LSI (IMTP peak force, involved/uninvolved)", metric_type: "imtp_peak_force", kind: "lsi", operator: ">=", target: 70, unit: "%" },
  { id: "s1c4", label: "Hop test symmetry ≥70%", kind: "context", note: "Hop-test symmetry documented by the athlete's performance team; this platform has no hop-test data source configured." },
  { id: "s1c5", label: "Comfortable weight-bearing confirmed", kind: "context", note: "Documented by the athlete's performance team." },
]);
addStage(2, "Strength restoration", "Rebuild force capacity; track limb symmetry on isometric testing, per performance-staff guidance (illustrative demo stage).", "completed", "2026-04-20", "2026-05-31", [
  { id: "s2c1", label: "MVIC LSI 80–85% (IMTP peak force, involved/uninvolved)", metric_type: "imtp_peak_force", kind: "lsi", operator: ">=", target: 80, unit: "% (stage target band: 80–85%)" },
  { id: "s2c2", label: "CMJ jump height vs reference baseline", metric_type: "cmj_jump_height", kind: "baseline_pct", operator: ">=", target: 75, unit: "%" },
  { id: "s2c3", label: "Full comfortable range of motion", kind: "context", note: "Documented by the athlete's performance team." },
]);
addStage(3, "Power & reactive capacity", "Restore braking capacity, reactive strength, and jump output toward reference-baseline levels (illustrative demo stage, practitioner-defined for this facility).", "current", "2026-06-01", null, [
  { id: "s3c1", label: "Eccentric braking impulse LSI (involved/uninvolved)", metric_type: "cmj_ecc_braking_impulse", kind: "lsi", operator: ">=", target: 90, unit: "%" },
  { id: "s3c2", label: "IMTP peak force LSI (involved/uninvolved)", metric_type: "imtp_peak_force", kind: "lsi", operator: ">=", target: 90, unit: "%" },
  { id: "s3c3", label: "CMJ jump height vs reference baseline", metric_type: "cmj_jump_height", kind: "baseline_pct", operator: ">=", target: 90, unit: "%" },
  { id: "s3c4", label: "Drop jump RSI", metric_type: "dj_rsi", kind: "absolute", operator: ">=", target: 2.0, unit: "" },
  { id: "s3c5", label: "Lower-leg reactive capacity review", kind: "context", note: "This platform has no isolated lower-leg dynamometry data source; drop jump RSI and eccentric braking impulse LSI above are the closest computed proxies. The direct assessment is documented by the athlete's performance team." },
  { id: "s3c6", label: "Full comfortable range of motion", kind: "context", note: "Documented by the athlete's performance team." },
]);
addStage(4, "Full training reintegration", "Progressive return to full training volume and intensity, per performance-staff guidance (illustrative demo stage).", "pending", null, null, [
  { id: "s4c1", label: "Eccentric braking impulse LSI", metric_type: "cmj_ecc_braking_impulse", kind: "lsi", operator: ">=", target: 95, unit: "%" },
  { id: "s4c2", label: "CMJ jump height vs reference baseline", metric_type: "cmj_jump_height", kind: "baseline_pct", operator: ">=", target: 95, unit: "%" },
  { id: "s4c3", label: "IMTP peak force LSI ≥90%", metric_type: "imtp_peak_force", kind: "lsi", operator: ">=", target: 90, unit: "%" },
  { id: "s4c4", label: "Full symmetric range of motion, confirmed comfortable", kind: "context", note: "Documented by the athlete's performance team." },
]);

/* ---------------- clinical assessments (human-authored) ---------------- */

function addAssessment(athleteId: string, on: string, assessor: string, category: string, summary: string) {
  db.prepare(
    `INSERT INTO clinical_assessment (id, facility_id, athlete_id, assessed_on, assessor, category, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId(), RPI, athleteId, on, assessor, category, summary, now);
}
addAssessment(maya.id, "2026-03-01", "Performance staff", "practitioner_note", "Athlete's own support team confirmed force-plate testing can resume within the staged progression. Testing is for monitoring only. (Synthetic demo note.)");
addAssessment(maya.id, "2026-05-30", "Performance staff", "movement_review", "Movement review satisfactory for progression to Stage 3 per the support team's judgment. Data reviewed alongside, not in place of, that judgment. (Synthetic demo note.)");
addAssessment(maya.id, "2026-07-02", "Performance staff", "subjective_readiness", "Athlete reports confidence in straight-line work; hesitancy on sharp decelerations persists. Consistent with current braking-impulse asymmetry data. (Synthetic demo note.)");

/* ---------------- milestones ---------------- */

function addMilestone(athleteId: string, on: string, label: string, kind: string) {
  db.prepare(
    `INSERT INTO milestone (id, facility_id, athlete_id, milestone_date, label, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(newId(), RPI, athleteId, on, label, kind, now);
}
addMilestone(maya.id, "2026-01-12", "Training interruption began", "injury");
addMilestone(maya.id, "2026-01-26", "Supervised recovery block began", "note");
addMilestone(maya.id, "2026-03-02", "Stage 1 entered — testing resumes", "stage_change");
addMilestone(maya.id, "2026-04-20", "Stage 2 entered", "stage_change");
addMilestone(maya.id, "2026-06-01", "Stage 3 entered", "stage_change");

/* ---------------- training sessions ---------------- */

function addTraining(
  facilityId: string, athleteId: string, on: string, type: string,
  durationMin: number, rpe: number, notes: string | null = null
) {
  const id = newId();
  db.prepare(
    `INSERT INTO training_session (id, facility_id, athlete_id, session_date, session_type, duration_min, rpe, load_au, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, facilityId, athleteId, on, type, durationMin, rpe, Math.round(durationMin * rpe), notes, now);
  return id;
}

// Maya: rehab strength sessions 3x/week from March
{
  let d = "2026-03-03";
  const rand = rng(2026);
  while (d <= TODAY) {
    addTraining(RPI, maya.id, d, "rehab", 60 + Math.round(rand() * 20), 5 + Math.round(rand() * 2));
    d = addDays(d, 2 + Math.round(rand() * 2));
  }
}

// Tessa: normal block, then a deliberately heavy week before her last two tests
{
  let d = "2026-05-01";
  const rand = rng(77);
  while (d <= "2026-06-28") {
    addTraining(RPI, tessa.id, d, "practice", 75, 5 + Math.round(rand() * 2));
    d = addDays(d, 2);
  }
  // heavy loading 72h before the two flagged test sessions (2026-07-03, 2026-07-07)
  addTraining(RPI, tessa.id, "2026-06-30", "conditioning", 110, 9, "High-volume conditioning block");
  addTraining(RPI, tessa.id, "2026-07-01", "strength", 100, 9, "Heavy lower-body strength");
  addTraining(RPI, tessa.id, "2026-07-04", "conditioning", 115, 9, "Repeat sprint session");
  addTraining(RPI, tessa.id, "2026-07-05", "practice", 105, 8);
}

/* ---------------- VBT: exercise sets + velocity reps for Maya ---------------- */

{
  const rand = rng(5150);
  // three L–V characterization sessions across rehab, back squat
  const sessions: { date: string; loads: number[]; baseV: number }[] = [
    { date: "2026-04-10", loads: [40, 55, 70, 85], baseV: 1.02 },
    { date: "2026-05-22", loads: [45, 60, 75, 90], baseV: 1.06 },
    { date: "2026-07-01", loads: [50, 65, 80, 95], baseV: 1.1 },
  ];
  // NOTE: no load_velocity_profile rows are authored here anymore — the app
  // rebuilds every profile live from these stored reps (services/loadVelocity).
  for (const s of sessions) {
    const tsId = addTraining(RPI, maya.id, s.date, "strength", 70, 7, "Load–velocity characterization: back squat");
    s.loads.forEach((load, i) => {
      const setId = newId();
      db.prepare(
        `INSERT INTO exercise_set (id, facility_id, training_session_id, exercise, set_number, load_kg, reps, created_at)
         VALUES (?, ?, ?, 'back_squat', ?, ?, 3, ?)`
      ).run(setId, RPI, tsId, i + 1, load, now);
      const setVel = s.baseV - load * 0.0072 + (rand() - 0.5) * 0.03;
      for (let rep = 1; rep <= 3; rep++) {
        db.prepare(
          `INSERT INTO velocity_rep (id, facility_id, exercise_set_id, rep_number, mean_velocity_ms, peak_velocity_ms, method_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, '1.0.0', ?)`
        ).run(newId(), RPI, setId, rep, Math.round((setVel + (rand() - 0.5) * 0.04) * 100) / 100, Math.round((setVel * 1.6) * 100) / 100, now);
      }
    });
  }
}

/* ---------------- VBT: two-point and insufficient-data demo states ---------------- */

// Small helper: one VBT training session with explicit loads × reps.
function addVbtSession(
  athleteId: string,
  date: string,
  exercise: string,
  loads: { loadKg: number; reps: { v: number; flag?: string }[] }[],
  note: string
) {
  const tsId = addTraining(RPI, athleteId, date, "strength", 45, 7, note);
  loads.forEach((l, i) => {
    const setId = newId();
    db.prepare(
      `INSERT INTO exercise_set (id, facility_id, training_session_id, exercise, set_number, load_kg, reps, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(setId, RPI, tsId, exercise, i + 1, l.loadKg, l.reps.length, now);
    l.reps.forEach((r, ri) => {
      db.prepare(
        `INSERT INTO velocity_rep (id, facility_id, exercise_set_id, rep_number, mean_velocity_ms, peak_velocity_ms, method_version, quality_flag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '1.0.0', ?, ?)`
      ).run(newId(), RPI, setId, ri + 1, r.v, Math.round(r.v * 1.6 * 100) / 100, r.flag ?? null, now);
    });
  });
}

// Tessa — valid TWO-POINT profile (light + heavy trap-bar deadlift), with one
// coach-flagged rep proving explicit (never automatic) exclusion.
addVbtSession(tessa.id, "2026-07-02", "trap_bar_deadlift", [
  { loadKg: 60, reps: [{ v: 0.98 }, { v: 1.01 }, { v: 0.97 }] },
  { loadKg: 110, reps: [{ v: 0.46 }, { v: 0.44 }, { v: 0.61, flag: "bar path fault — coach flagged" }] },
], "Two-point load–velocity check: trap bar deadlift");

// Dario — INSUFFICIENT data: a single load only (no profile can be fitted).
addVbtSession(dario.id, "2026-07-05", "back_squat", [
  { loadKg: 80, reps: [{ v: 0.66 }, { v: 0.68 }, { v: 0.65 }] },
], "Velocity monitoring at working load only");

/* ---------------- synthetic force-plate histories ---------------- */

interface CmjSessionSpec { date: string; v: number; depth: number; leftShare: number; }
interface ImtpSessionSpec { date: string; peakNet: number; tau: number; leftShare: number; }
interface DjSessionSpec { date: string; contact: number; flight: number; }

function buildSyntheticInput(
  athlete: AthleteSpec, cmj: CmjSessionSpec[], imtp: ImtpSessionSpec[], dj: DjSessionSpec[],
  deviceId: string, seedBase: number
): SyntheticInput {
  const sessions: SyntheticInput["sessions"] = [];
  cmj.forEach((s, si) => {
    sessions.push({
      athleteId: athlete.id, testType: "cmj", sessionDate: s.date, deviceId,
      trials: [0, 1, 2].map((ti) => ({
        trialNumber: ti + 1,
        waveform: generateCmjTrace({
          massKg: athlete.massKg,
          takeoffVelocity: s.v + (ti - 1) * 0.015,
          depthFactor: s.depth,
          leftShare: s.leftShare,
          seed: seedBase + si * 10 + ti,
        }),
      })),
    });
  });
  imtp.forEach((s, si) => {
    sessions.push({
      athleteId: athlete.id, testType: "imtp", sessionDate: s.date, deviceId,
      trials: [0, 1].map((ti) => ({
        trialNumber: ti + 1,
        waveform: generateImtpTrace({
          massKg: athlete.massKg,
          peakNetForceN: s.peakNet + (ti - 0.5) * 30,
          riseTau: s.tau,
          leftShare: s.leftShare,
          seed: seedBase + 5000 + si * 10 + ti,
        }),
      })),
    });
  });
  dj.forEach((s, si) => {
    sessions.push({
      athleteId: athlete.id, testType: "drop_jump", sessionDate: s.date, deviceId,
      trials: [0, 1].map((ti) => ({
        trialNumber: ti + 1,
        waveform: generateDjTrace({
          massKg: athlete.massKg,
          contactTimeS: s.contact + (ti - 0.5) * 0.008,
          flightTimeS: s.flight + (ti - 0.5) * 0.01,
          seed: seedBase + 9000 + si * 10 + ti,
        }),
      })),
    });
  });
  sessions.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  return { sessions };
}

function runSynthetic(athlete: AthleteSpec, input: SyntheticInput, facilityId = RPI, sourceId = srcSynthetic) {
  const result = runImportBatch(syntheticSignalAdapter, input, facilityId, sourceId, `${athlete.name} force-plate history`);
  if (result.status !== "complete") {
    console.error(`Seed batch FAILED for ${athlete.name}:`, result.validation.errors);
    process.exitCode = 1;
  } else {
    console.log(
      `${athlete.name}: ${result.sessionIds.length} sessions, ${result.metricCount} metrics, ${result.findingsGenerated} findings` +
      (result.failedTrials.length ? `, ${result.failedTrials.length} unscoreable trials` : "")
    );
  }
}

/* Maya — flagship: pre-injury baseline, gap, graded return */
{
  const cmj: CmjSessionSpec[] = [];
  const rand = rng(101);
  // pre-injury: 2025-09-01 → 2026-01-10, ~2x/week
  let d = "2025-09-01";
  while (d <= "2026-01-10") {
    cmj.push({ date: d, v: 2.55 + (rand() - 0.5) * 0.06, depth: 1.0 + (rand() - 0.5) * 0.06, leftShare: 0.5 + (rand() - 0.5) * 0.01 });
    d = addDays(d, 3 + Math.round(rand()));
  }
  // post-surgery return: 2026-03-09 → today, weekly; output and left-side share recover gradually
  let week = 0;
  d = "2026-03-09";
  while (d <= TODAY) {
    const progress = Math.min(1, week / 17);
    cmj.push({
      date: d,
      v: 2.1 + 0.26 * progress + (rand() - 0.5) * 0.04,
      depth: 1.18 - 0.13 * progress + (rand() - 0.5) * 0.04, // deeper, force-reliant strategy early on
      leftShare: 0.455 + 0.033 * progress + (rand() - 0.5) * 0.006,
    });
    d = addDays(d, 7);
    week++;
  }

  const imtp: ImtpSessionSpec[] = [];
  d = "2025-09-08";
  let i = 0;
  while (d <= "2026-01-05") {
    imtp.push({ date: d, peakNet: 1750 + (rand() - 0.5) * 80, tau: 0.16, leftShare: 0.5 + (rand() - 0.5) * 0.008 });
    d = addDays(d, 14);
    i++;
  }
  d = "2026-03-16";
  i = 0;
  while (d <= TODAY) {
    const progress = Math.min(1, i / 8);
    imtp.push({ date: d, peakNet: 1280 + 340 * progress + (rand() - 0.5) * 60, tau: 0.2 - 0.035 * progress, leftShare: 0.446 + 0.036 * progress });
    d = addDays(d, 14);
    i++;
  }

  const dj: DjSessionSpec[] = [];
  for (const dd of ["2025-10-06", "2025-11-03", "2025-12-01", "2026-01-05"]) {
    dj.push({ date: dd, contact: 0.205 + (rand() - 0.5) * 0.01, flight: 0.5 + (rand() - 0.5) * 0.015 });
  }
  let djDate = "2026-05-11";
  let j = 0;
  while (djDate <= TODAY) {
    const progress = Math.min(1, j / 4);
    dj.push({ date: djDate, contact: 0.245 - 0.025 * progress, flight: 0.46 + 0.045 * progress });
    djDate = addDays(djDate, 14);
    j++;
  }

  runSynthetic(maya, buildSyntheticInput(maya, cmj, imtp, dj, rpiPlate, 100000));
}

/* Tessa — stable baseline then 2 consecutive low sessions (deviation + training context) */
{
  const rand = rng(202);
  const cmj: CmjSessionSpec[] = [];
  let d = "2026-03-02";
  let n = 0;
  while (n < 24) {
    cmj.push({ date: d, v: 2.5 + (rand() - 0.5) * 0.05, depth: 1.0 + (rand() - 0.5) * 0.05, leftShare: 0.5 + (rand() - 0.5) * 0.012 });
    d = addDays(d, 5);
    n++;
  }
  // two flagged sessions after the heavy block: 2026-07-03 and 2026-07-07
  cmj.push({ date: "2026-07-03", v: 2.32, depth: 1.08, leftShare: 0.5 });
  cmj.push({ date: "2026-07-07", v: 2.3, depth: 1.1, leftShare: 0.5 });
  runSynthetic(tessa, buildSyntheticInput(tessa, cmj, [], [], rpiPlate, 200000));
}

/* Dario — braking asymmetry emerges while output stays stable */
{
  const rand = rng(303);
  const cmj: CmjSessionSpec[] = [];
  let d = "2026-02-02";
  for (let n = 0; n < 20; n++) {
    cmj.push({ date: d, v: 2.62 + (rand() - 0.5) * 0.05, depth: 0.98, leftShare: 0.5 + (rand() - 0.5) * 0.01 });
    d = addDays(d, 6);
  }
  // drift over the last 6 sessions
  for (let n = 0; n < 6; n++) {
    cmj.push({ date: d, v: 2.6 + (rand() - 0.5) * 0.05, depth: 0.98, leftShare: 0.5 - 0.0022 * (n + 1) });
    d = addDays(d, 6);
  }
  const imtp: ImtpSessionSpec[] = [];
  let di = "2026-02-09";
  for (let n = 0; n < 10; n++) {
    imtp.push({ date: di, peakNet: 2450 + (rand() - 0.5) * 90, tau: 0.15, leftShare: 0.5 + (rand() - 0.5) * 0.01 });
    di = addDays(di, 15);
  }
  runSynthetic(dario, buildSyntheticInput(dario, cmj, imtp, [], rpiPlate, 300000));
}

/* Malik — solid history but stale (last test >1 month ago) */
{
  const rand = rng(404);
  const cmj: CmjSessionSpec[] = [];
  let d = "2026-01-05";
  for (let n = 0; n < 22; n++) {
    cmj.push({ date: d, v: 2.7 + (rand() - 0.5) * 0.06, depth: 1.05, leftShare: 0.5 + (rand() - 0.5) * 0.012 });
    d = addDays(d, 6);
  }
  runSynthetic(malik, buildSyntheticInput(malik, cmj, [], [], rpiPlate, 400000));
}

/* Elena — healthy, current, unremarkable */
{
  const rand = rng(505);
  const cmj: CmjSessionSpec[] = [];
  let d = "2026-02-16";
  for (let n = 0; n < 20; n++) {
    cmj.push({ date: d, v: 2.48 + (rand() - 0.5) * 0.045, depth: 1.0, leftShare: 0.5 + (rand() - 0.5) * 0.01 });
    d = addDays(d, 7);
  }
  const dj: DjSessionSpec[] = [
    { date: "2026-06-15", contact: 0.215, flight: 0.48 },
    { date: "2026-07-06", contact: 0.21, flight: 0.49 },
  ];
  runSynthetic(elena, buildSyntheticInput(elena, cmj, [], dj, rpiPlate, 500000));
}

/* Sofia — new athlete, only 4 sessions (baseline not yet established) */
{
  const rand = rng(606);
  const cmj: CmjSessionSpec[] = [];
  let d = "2026-06-15";
  for (let n = 0; n < 4; n++) {
    cmj.push({ date: d, v: 2.4 + (rand() - 0.5) * 0.05, depth: 1.0, leftShare: 0.5 });
    d = addDays(d, 7);
  }
  runSynthetic(sofia, buildSyntheticInput(sofia, cmj, [], [], rpiPlate, 600000));
}

/* Harbor City FC — separate facility, proves scoping */
{
  for (const [athlete, seedBase] of [[kofi, 700000], [lucas, 800000]] as const) {
    const rand = rng(seedBase);
    const cmj: CmjSessionSpec[] = [];
    let d = "2026-04-06";
    for (let n = 0; n < 12; n++) {
      cmj.push({ date: d, v: 2.58 + (rand() - 0.5) * 0.05, depth: 1.0, leftShare: 0.5 + (rand() - 0.5) * 0.012 });
      d = addDays(d, 7);
    }
    const input = buildSyntheticInput(athlete, cmj, [], [], hcfcPlate, seedBase);
    const result = runImportBatch(syntheticSignalAdapter, input, HCFC, srcSyntheticHc, `${athlete.name} force-plate history`);
    console.log(`${athlete.name} (Harbor City): ${result.status}, ${result.metricCount} metrics`);
  }
}

/* ---------------- CSV import: Jonas IMTP sided values ---------------- */

{
  const rows: string[] = ["athlete_id,test_type,session_date,metric_type,side,value"];
  const rand = rng(909);
  let d = "2026-05-04";
  for (let n = 0; n < 6; n++) {
    const right = 3150 + (rand() - 0.5) * 100;
    const ratio = 0.94 - n * 0.012; // asymmetry grows toward ~12%
    const left = right * ratio;
    rows.push(`${jonas.id},imtp,${d},imtp_peak_force,left,${left.toFixed(0)}`);
    rows.push(`${jonas.id},imtp,${d},imtp_peak_force,right,${right.toFixed(0)}`);
    rows.push(`${jonas.id},imtp,${d},imtp_peak_force,bilateral,${(left + right).toFixed(0)}`);
    rows.push(`${jonas.id},imtp,${d},imtp_relative_force,bilateral,${((left + right) / 88).toFixed(2)}`);
    d = addDays(d, 12);
  }
  const result = runImportBatch(
    csvGenericAdapter,
    { filename: "jonas_imtp_export.csv", content: rows.join("\n") },
    RPI, srcCsv, "jonas_imtp_export.csv"
  );
  console.log(`CSV import (Jonas): ${result.status}, ${result.metricCount} metrics, ${result.findingsGenerated} findings`);
}

/* ---------------- Demo dataset import: Priya (metric-only, no sides) ---------------- */

{
  const rand = rng(808);
  const dataset: { athleteId: string; testType: string; sessionDate: string; values: { metricType: string; value: number }[] }[] = [];
  let d = "2026-04-01";
  for (let n = 0; n < 10; n++) {
    dataset.push({
      athleteId: priya.id, testType: "cmj", sessionDate: d,
      values: [
        { metricType: "cmj_jump_height", value: Math.round((36 + (rand() - 0.5) * 2.4) * 10) / 10 },
        { metricType: "cmj_mrsi", value: Math.round((0.52 + (rand() - 0.5) * 0.05) * 100) / 100 },
      ],
    });
    d = addDays(d, 10);
  }
  const result = runImportBatch(demoDatasetAdapter, { dataset }, RPI, srcDemo, "public demo dataset (jump testing)");
  console.log(`Demo dataset (Priya): ${result.status}, ${result.metricCount} metrics`);
}

/* ---------------- Manual entry: Elena drop-jump RSI session ---------------- */

{
  const result = runImportBatch(
    manualEntryAdapter,
    {
      athleteId: elena.id, testType: "drop_jump", sessionDate: "2026-07-08",
      notes: "Stopwatch/contact-mat session — plates in use.",
      metrics: [{ metricType: "dj_rsi", side: "bilateral" as const, value: 2.21 }],
    },
    RPI, srcManual, "manual entry — Elena Brooks DJ"
  );
  console.log(`Manual entry (Elena): ${result.status}, ${result.metricCount} metrics`);
}

/* ---------------- Men's Basketball — 15-player demo team ----------------
 *
 * One coherent team at Ridgeline (same facility, same dual plate): exactly
 * 6 guards, 6 forwards, 3 centers. All names/values are synthetic. Built for
 * team/position comparison demos: realistic position-typical distributions,
 * mixed trends (improving / flat / declining / mid-season dip), genuine
 * bilateral asymmetry with side changes, and a few HONEST gaps — a new
 * signing with 2 sessions, a CMJ-only forward, a stale sparse center — so
 * insufficient-data states are visible. The 3-center group intentionally
 * keeps position cohorts under the n<5 small-sample warning threshold.
 */

interface HooperSpec {
  a: AthleteSpec;
  /** CMJ takeoff velocity at window start + total drift across the window */
  cmjV0: number;
  cmjTrend: number;
  /** IMTP net peak force per body mass (N/kg) at window start + drift */
  imtpNkg0: number;
  imtpTrend: number;
  /** left-plate share of force; drift moves it across 0.5 to flip sides */
  leftShare: number;
  leftDrift: number;
  cmjSessions: number;
  imtpSessions: number;
  startDate: string;
  /** IMTP rise time constant (centers slower to peak) */
  tau: number;
  /** mid-window performance dip (fraction of v, e.g. 0.05 = −5% at midpoint) */
  dip?: number;
}

{
  const bballTeam = "Men's Basketball";
  const hooper = (
    name: string, position: string, heightCm: number, massKg: number, birthYear: number
  ): AthleteSpec => ({
    id: newId(), name, sport: "Basketball", position, team: bballTeam,
    sex: "M", birthYear, heightCm, massKg, status: "active",
  });

  const squad: HooperSpec[] = [
    // -------- guards (6): springier jumps, lighter, faster to peak --------
    { a: hooper("Jaylen Carter", "Guard", 188, 86, 2002), cmjV0: 2.74, cmjTrend: 0.06, imtpNkg0: 29.5, imtpTrend: 1.2, leftShare: 0.502, leftDrift: 0, cmjSessions: 13, imtpSessions: 8, startDate: "2026-01-12", tau: 0.23 },
    { a: hooper("Marcus Webb", "Guard", 191, 89, 2001), cmjV0: 2.66, cmjTrend: 0.0, imtpNkg0: 30.8, imtpTrend: 0.2, leftShare: 0.493, leftDrift: 0, cmjSessions: 12, imtpSessions: 7, startDate: "2026-01-19", tau: 0.24 },
    { a: hooper("Deshawn Riley", "Guard", 185, 83, 2003), cmjV0: 2.7, cmjTrend: 0.03, imtpNkg0: 28.4, imtpTrend: 0.8, leftShare: 0.497, leftDrift: 0.012, cmjSessions: 13, imtpSessions: 8, startDate: "2026-01-14", tau: 0.23 }, // stronger side flips across the season
    { a: hooper("Tyrese Coleman", "Guard", 193, 92, 2000), cmjV0: 2.62, cmjTrend: -0.05, imtpNkg0: 31.2, imtpTrend: -0.9, leftShare: 0.508, leftDrift: 0, cmjSessions: 12, imtpSessions: 7, startDate: "2026-01-21", tau: 0.25, dip: 0.02 }, // gradual decline
    { a: hooper("Andre Boateng", "Guard", 186, 84, 2004), cmjV0: 2.58, cmjTrend: 0.09, imtpNkg0: 26.9, imtpTrend: 2.1, leftShare: 0.499, leftDrift: 0, cmjSessions: 14, imtpSessions: 8, startDate: "2026-01-13", tau: 0.24 }, // young, improving fast
    { a: hooper("Nico Petrov", "Guard", 190, 88, 2005), cmjV0: 2.6, cmjTrend: 0, imtpNkg0: 27.5, imtpTrend: 0, leftShare: 0.5, leftDrift: 0, cmjSessions: 2, imtpSessions: 0, startDate: "2026-06-22", tau: 0.24 }, // new signing — 2 sessions, no IMTP yet
    // -------- forwards (6) --------
    { a: hooper("Isaiah Grant", "Forward", 201, 98, 2001), cmjV0: 2.56, cmjTrend: 0.04, imtpNkg0: 30.1, imtpTrend: 0.9, leftShare: 0.503, leftDrift: 0, cmjSessions: 13, imtpSessions: 8, startDate: "2026-01-12", tau: 0.26 },
    { a: hooper("Omar Haddad", "Forward", 198, 96, 2002), cmjV0: 2.5, cmjTrend: 0.01, imtpNkg0: 29.0, imtpTrend: 0.4, leftShare: 0.472, leftDrift: 0, cmjSessions: 12, imtpSessions: 8, startDate: "2026-01-15", tau: 0.27 }, // persistent right-dominant asymmetry ~11% (watch band)
    { a: hooper("Caleb Nakamura", "Forward", 203, 101, 2003), cmjV0: 2.48, cmjTrend: 0.05, imtpNkg0: 28.2, imtpTrend: 1.4, leftShare: 0.496, leftDrift: 0, cmjSessions: 13, imtpSessions: 7, startDate: "2026-01-20", tau: 0.27 },
    { a: hooper("Victor Osei", "Forward", 200, 99, 2000), cmjV0: 2.53, cmjTrend: -0.02, imtpNkg0: 31.0, imtpTrend: 0.1, leftShare: 0.505, leftDrift: 0, cmjSessions: 12, imtpSessions: 7, startDate: "2026-01-16", tau: 0.26, dip: 0.05 }, // mid-season dip, partial recovery
    { a: hooper("Liam Donnelly", "Forward", 199, 97, 2004), cmjV0: 2.45, cmjTrend: 0.03, imtpNkg0: 27.0, imtpTrend: 0, leftShare: 0.501, leftDrift: 0, cmjSessions: 11, imtpSessions: 0, startDate: "2026-02-02", tau: 0.27 }, // CMJ only — no IMTP history
    { a: hooper("Rashad Fields", "Forward", 204, 103, 2002), cmjV0: 2.51, cmjTrend: 0.02, imtpNkg0: 29.8, imtpTrend: 0.7, leftShare: 0.492, leftDrift: 0, cmjSessions: 13, imtpSessions: 8, startDate: "2026-01-13", tau: 0.26 },
    // -------- centers (3): heavier, lower jumps, high absolute force, slower to peak --------
    { a: hooper("Dmitri Volkov", "Center", 211, 114, 2001), cmjV0: 2.36, cmjTrend: 0.02, imtpNkg0: 30.5, imtpTrend: 0.5, leftShare: 0.506, leftDrift: 0, cmjSessions: 12, imtpSessions: 7, startDate: "2026-01-19", tau: 0.3 },
    { a: hooper("Samuel Adeyemi", "Center", 209, 110, 2003), cmjV0: 2.4, cmjTrend: 0.05, imtpNkg0: 28.6, imtpTrend: 1.1, leftShare: 0.494, leftDrift: 0, cmjSessions: 12, imtpSessions: 7, startDate: "2026-01-22", tau: 0.29 },
    { a: hooper("Ben Kowalski", "Center", 213, 117, 2000), cmjV0: 2.32, cmjTrend: -0.01, imtpNkg0: 31.5, imtpTrend: 0, leftShare: 0.503, leftDrift: 0, cmjSessions: 4, imtpSessions: 3, startDate: "2026-02-09", tau: 0.31 }, // sparse + stale — last tested well before TODAY
  ];

  const guards = squad.filter((s) => s.a.position === "Guard").length;
  const forwards = squad.filter((s) => s.a.position === "Forward").length;
  const centers = squad.filter((s) => s.a.position === "Center").length;
  if (guards !== 6 || forwards !== 6 || centers !== 3) {
    throw new Error(`Basketball squad composition wrong: ${guards}G/${forwards}F/${centers}C (need 6/6/3)`);
  }

  squad.forEach((spec, idx) => {
    addAthlete(RPI, spec.a);
    const rand = rng(910_000 + idx * 1_000);
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

    // Ben Kowalski's sparse block runs on a long cadence and ends in spring
    // (stale); everyone else tests through late June / early July.
    const cmjCadence = spec.a.name === "Ben Kowalski" ? 18 : 13;
    const cmj: CmjSessionSpec[] = [];
    let d = spec.startDate;
    for (let n = 0; n < spec.cmjSessions; n++) {
      if (d > TODAY) break; // never seed sessions after the demo's "today"
      const progress = spec.cmjSessions > 1 ? n / (spec.cmjSessions - 1) : 0;
      // optional mid-window dip: gaussian bump centered at progress 0.5
      const dip = spec.dip ? spec.dip * Math.exp(-Math.pow((progress - 0.5) / 0.18, 2)) : 0;
      cmj.push({
        date: d,
        v: spec.cmjV0 + spec.cmjTrend * progress - spec.cmjV0 * dip + (rand() - 0.5) * 0.05,
        depth: 1.0 + (rand() - 0.5) * 0.05,
        leftShare: clamp(spec.leftShare + spec.leftDrift * (progress - 0.5) * 2 + (rand() - 0.5) * 0.008, 0.42, 0.58),
      });
      d = addDays(d, cmjCadence + Math.round(rand() * 3));
    }

    const imtp: ImtpSessionSpec[] = [];
    d = addDays(spec.startDate, 4);
    for (let n = 0; n < spec.imtpSessions; n++) {
      if (d > TODAY) break; // never seed sessions after the demo's "today"
      const progress = spec.imtpSessions > 1 ? n / (spec.imtpSessions - 1) : 0;
      imtp.push({
        date: d,
        peakNet: (spec.imtpNkg0 + spec.imtpTrend * progress + (rand() - 0.5) * 0.8) * spec.a.massKg,
        tau: spec.tau + (rand() - 0.5) * 0.02,
        leftShare: clamp(spec.leftShare + spec.leftDrift * (progress - 0.5) * 2 + (rand() - 0.5) * 0.008, 0.42, 0.58),
      });
      d = addDays(d, 21 + Math.round(rand() * 4));
    }

    runSynthetic(spec.a, buildSyntheticInput(spec.a, cmj, imtp, [], rpiPlate, 910_000 + idx * 1_000));
  });
}

/* ---------------- organizations + demo users (security foundation) ---------------- */

import { createUser, addMembership } from "../src/lib/auth/auth";

{
  const org1 = newId();
  const org2 = newId();
  db.prepare(`INSERT INTO organization (id, name, created_at) VALUES (?, ?, ?)`).run(org1, "Ridgeline Sports Group", now);
  db.prepare(`INSERT INTO organization (id, name, created_at) VALUES (?, ?, ?)`).run(org2, "Harbor City Athletics", now);
  db.prepare(`UPDATE facility SET organization_id = ? WHERE id = ?`).run(org1, RPI);
  db.prepare(`UPDATE facility SET organization_id = ? WHERE id = ?`).run(org2, HCFC);

  // Demo credentials (synthetic, documented): production deployments use the
  // invitation/activation flow instead of pre-seeded passwords.
  const PW = "demo-password-123";
  const users: [string, string, string, ("admin" | "coach" | "analyst" | "readonly")[]][] = [
    ["admin@ridgeline.demo", "Ridgeline Admin", RPI, ["admin"]],
    ["coach@ridgeline.demo", "Ridgeline Coach", RPI, ["coach"]],
    ["analyst@ridgeline.demo", "Ridgeline Analyst", RPI, ["analyst"]],
    ["viewer@ridgeline.demo", "Ridgeline Viewer", RPI, ["readonly"]],
    ["coach@harborcity.demo", "Harbor City Coach", HCFC, ["coach"]],
  ];
  for (const [email, name, fac, roles] of users) {
    const u = createUser(email, name, PW);
    for (const role of roles) addMembership(u.id, fac, role);
  }
  // one multi-facility user: coach at Ridgeline AND Harbor City
  const multi = createUser("multi@tracelab.demo", "Traveling Coach", PW);
  addMembership(multi.id, RPI, "coach");
  addMembership(multi.id, HCFC, "coach");
  console.log(`Demo users seeded (password: ${PW}) — admin/coach/analyst/viewer@ridgeline.demo, coach@harborcity.demo, multi@tracelab.demo`);
}

/* ---------------- monitoring templates + job (Phase 4/5 demo states) ---------------- */

import { savePolicyLayer } from "../src/lib/services/monitoringPolicy";
import { runMonitoringJob } from "../src/lib/services/alerts";

{
  // Facility templates: Ridgeline monitors jump height + IMTP peak force;
  // Harbor City keeps the product default (jump height only).
  savePolicyLayer(RPI, "facility", { metricKeys: ["cmj_jump_height", "imtp_peak_force"] }, { createdBy: null });
  // Athlete override example: Kai on a 7-session rolling window.
  savePolicyLayer(RPI, "athlete", { rollingWindow: 7 }, { athleteId: maya.id, createdBy: null });
  const r1 = runMonitoringJob(RPI);
  const r2 = runMonitoringJob(HCFC);
  console.log(`Monitoring job: RPI ${r1.athletes} athletes → ${r1.alertsCreated} alerts; HCFC ${r2.athletes} athletes → ${r2.alertsCreated} alerts`);
}

/* ---------------- summary ---------------- */

const counts = (table: string) =>
  (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
console.log("\nSeed complete:");
for (const t of ["facility", "athlete", "session", "trial", "metric", "finding", "import_batch", "training_session", "velocity_rep"]) {
  console.log(`  ${t}: ${counts(t)}`);
}
