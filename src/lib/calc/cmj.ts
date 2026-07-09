/**
 * CMJ (Countermovement Jump) calculations from vertical force-time data.
 * Method version: cmj@1.0.0
 *
 * Phase model (documented in METHODOLOGY.md):
 * - Quiet standing (≥1 s) → BW.
 * - Movement start: |F − BW| > 5·SD(quiet) sustained ≥20 ms.
 * - Unweighting: F below BW; velocity goes negative.
 * - Braking: from peak negative velocity to v = 0 (lowest countermovement point).
 * - Propulsion: from v = 0 to takeoff.
 * - Takeoff: first sample after movement start where F < 20 N.
 * - Jump height via impulse–momentum: h = v_takeoff² / (2g). NOT flight time.
 * - mRSI = jump height (m) / time-to-takeoff (s), where time-to-takeoff runs
 *   from movement start to takeoff.
 * - Eccentric braking impulse: ∫(F − BW)dt over the braking phase (N·s, positive).
 */

import { ForceTimeSeries, quietStanding, velocityFromForce, impulse, GRAVITY } from "./signal";

export const CMJ_METHOD_VERSION = "1.0.0";
const TAKEOFF_THRESHOLD_N = 20;

export interface CmjResult {
  methodVersion: string;
  bodyWeightN: number;
  bodyMassKg: number;
  movementStartIndex: number;
  takeoffIndex: number;
  brakingStartIndex: number;
  brakingEndIndex: number;
  takeoffVelocityMs: number;
  /** impulse–momentum jump height, cm */
  jumpHeightCm: number;
  /** modified reactive strength index, m/s */
  mrsi: number;
  /** total eccentric braking impulse, N·s */
  eccBrakingImpulseNs: number;
  eccBrakingImpulseLeftNs?: number;
  eccBrakingImpulseRightNs?: number;
  peakPropulsiveForceN: number;
  peakPropulsiveForceLeftN?: number;
  peakPropulsiveForceRightN?: number;
  timeToTakeoffS: number;
  warnings: string[];
}

function detectMovementStart(series: ForceTimeSeries, bw: number, qsd: number): number {
  const threshold = 5 * qsd;
  const hold = Math.max(1, Math.round(0.02 * series.hz));
  // start scanning after the quiet window
  const startScan = Math.round(1.0 * series.hz);
  for (let i = startScan; i < series.force.length - hold; i++) {
    if (Math.abs(series.force[i] - bw) > threshold) {
      let ok = true;
      for (let j = i; j < i + hold; j++) {
        if (Math.abs(series.force[j] - bw) <= threshold) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return -1;
}

export function computeCmj(series: ForceTimeSeries): CmjResult {
  const warnings: string[] = [];
  const { bw, sd: qsd } = quietStanding(series, 1.0);
  const massKg = bw / GRAVITY;

  const start = detectMovementStart(series, bw, qsd);
  if (start < 0) throw new Error("CMJ movement start not detected.");

  // takeoff: first near-zero force after movement start
  let takeoff = -1;
  for (let i = start; i < series.force.length; i++) {
    if (series.force[i] < TAKEOFF_THRESHOLD_N) {
      takeoff = i;
      break;
    }
  }
  if (takeoff < 0) throw new Error("CMJ takeoff not detected (force never dropped below threshold).");

  // velocity from movement start to takeoff
  const v = velocityFromForce(series, bw, start, takeoff + 1);
  const takeoffVelocity = v[v.length - 1];
  if (takeoffVelocity <= 0) throw new Error("Non-positive takeoff velocity — trial invalid.");

  // braking phase: peak negative velocity -> first zero crossing
  let minVIdx = 0;
  for (let i = 1; i < v.length; i++) if (v[i] < v[minVIdx]) minVIdx = i;
  let zeroIdx = -1;
  for (let i = minVIdx; i < v.length; i++) {
    if (v[i] >= 0) {
      zeroIdx = i;
      break;
    }
  }
  if (zeroIdx < 0) throw new Error("CMJ braking phase end not found.");
  const brakingStart = start + minVIdx;
  const brakingEnd = start + zeroIdx;

  const eccBrakingImpulseNs = impulse(series, bw, brakingStart, brakingEnd);

  let eccL: number | undefined;
  let eccR: number | undefined;
  let peakPropL: number | undefined;
  let peakPropR: number | undefined;
  if (series.left && series.right) {
    const leftSeries: ForceTimeSeries = { hz: series.hz, force: series.left };
    const rightSeries: ForceTimeSeries = { hz: series.hz, force: series.right };
    // per-side braking impulse against half body weight (assumes bilateral stance)
    eccL = impulse(leftSeries, bw / 2, brakingStart, brakingEnd);
    eccR = impulse(rightSeries, bw / 2, brakingStart, brakingEnd);
    peakPropL = Math.max(...series.left.slice(brakingEnd, takeoff));
    peakPropR = Math.max(...series.right.slice(brakingEnd, takeoff));
  }

  const jumpHeightM = takeoffVelocity ** 2 / (2 * GRAVITY);
  const timeToTakeoffS = (takeoff - start) / series.hz;
  const peakPropulsiveForceN = Math.max(...series.force.slice(brakingEnd, takeoff));

  if (timeToTakeoffS > 2.0) warnings.push("Unusually long time to takeoff (>2 s); check trial quality.");

  return {
    methodVersion: CMJ_METHOD_VERSION,
    bodyWeightN: bw,
    bodyMassKg: massKg,
    movementStartIndex: start,
    takeoffIndex: takeoff,
    brakingStartIndex: brakingStart,
    brakingEndIndex: brakingEnd,
    takeoffVelocityMs: takeoffVelocity,
    jumpHeightCm: jumpHeightM * 100,
    mrsi: jumpHeightM / timeToTakeoffS,
    eccBrakingImpulseNs,
    eccBrakingImpulseLeftNs: eccL,
    eccBrakingImpulseRightNs: eccR,
    peakPropulsiveForceN,
    peakPropulsiveForceLeftN: peakPropL,
    peakPropulsiveForceRightN: peakPropR,
    timeToTakeoffS,
    warnings,
  };
}

/**
 * Drop Jump RSI: flight time / ground contact time.
 * Expects a force series covering landing → contact → takeoff → flight → second landing.
 * Method version dj@1.0.0.
 */
export const DJ_METHOD_VERSION = "1.0.0";

export interface DjResult {
  methodVersion: string;
  contactTimeS: number;
  flightTimeS: number;
  rsi: number;
}

export function computeDropJumpRsi(series: ForceTimeSeries): DjResult {
  const f = series.force;
  const thr = TAKEOFF_THRESHOLD_N;
  // find first contact (force rises above threshold)
  let contactStart = -1;
  for (let i = 0; i < f.length; i++)
    if (f[i] > thr) {
      contactStart = i;
      break;
    }
  if (contactStart < 0) throw new Error("DJ contact not detected.");
  let takeoff = -1;
  for (let i = contactStart; i < f.length; i++)
    if (f[i] < thr) {
      takeoff = i;
      break;
    }
  if (takeoff < 0) throw new Error("DJ takeoff not detected.");
  let landing = -1;
  for (let i = takeoff; i < f.length; i++)
    if (f[i] > thr) {
      landing = i;
      break;
    }
  if (landing < 0) throw new Error("DJ second landing not detected.");

  const contactTimeS = (takeoff - contactStart) / series.hz;
  const flightTimeS = (landing - takeoff) / series.hz;
  if (contactTimeS <= 0) throw new Error("DJ invalid contact time.");
  return {
    methodVersion: DJ_METHOD_VERSION,
    contactTimeS,
    flightTimeS,
    rsi: flightTimeS / contactTimeS,
  };
}
