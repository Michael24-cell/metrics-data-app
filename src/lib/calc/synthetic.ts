/**
 * Deterministic synthetic force-time signal generation.
 *
 * Used for (a) calculation-engine tests with known ground truth, and
 * (b) the synthetic-signal adapter that feeds demo data through the real
 * import → compute pipeline. Seeded PRNG → fully reproducible.
 */

import { ForceTimeSeries, GRAVITY } from "./signal";

/** Mulberry32 — small deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CmjParams {
  massKg: number;
  /** target takeoff velocity, m/s (drives jump height) */
  takeoffVelocity: number;
  /** countermovement depth factor 0.5–1.5 (higher = deeper/slower strategy) */
  depthFactor: number;
  /** left share of total force, 0–1 (0.5 = symmetric) */
  leftShare: number;
  seed: number;
  hz?: number;
}

/**
 * Generates a physically consistent CMJ force trace:
 * quiet standing → unweighting → braking → propulsion → takeoff → flight.
 * The trace is built so that the net impulse to takeoff equals m·v_target,
 * so impulse–momentum recovers the requested takeoff velocity.
 */
export function generateCmjTrace(p: CmjParams): ForceTimeSeries {
  const hz = p.hz ?? 1000;
  const rand = rng(p.seed);
  const bw = p.massKg * GRAVITY;
  const noise = () => (rand() - 0.5) * 8; // ±4 N sensor noise

  const quietS = 1.2;
  const unweightS = 0.30 * p.depthFactor;
  const brakeS = 0.22 * p.depthFactor;
  const propS = 0.26 * p.depthFactor;
  const flightS = 0.45;

  const force: number[] = [];
  const push = (val: number) => force.push(Math.max(0, val + noise()));

  // quiet standing
  for (let i = 0; i < quietS * hz; i++) push(bw);

  // unweighting: force dips below BW (half-sine dip)
  const unweightDepth = 0.55 * bw;
  const nU = Math.round(unweightS * hz);
  for (let i = 0; i < nU; i++) {
    push(bw - unweightDepth * Math.sin((Math.PI * i) / nU));
  }
  // net negative impulse accumulated during unweighting:
  const negImpulse = (unweightDepth * unweightS * 2) / Math.PI;

  // braking: force above BW, half-sine, sized to cancel the negative impulse
  const nB = Math.round(brakeS * hz);
  const brakeAmp = (negImpulse * Math.PI) / (2 * brakeS);
  for (let i = 0; i < nB; i++) {
    push(bw + brakeAmp * Math.sin((Math.PI * i) / nB));
  }

  // propulsion: half-sine above BW sized so net impulse = m * v_target,
  // compensating for the negative net impulse of the pre-takeoff unload ramp
  // (force ramps 0.4·BW → 0 over dropS, i.e. net ≈ −(BW − 0.2·BW)·dropS)
  const dropS = 0.02;
  const unloadLoss = 0.8 * bw * dropS;
  const targetImpulse = p.massKg * p.takeoffVelocity + unloadLoss;
  const nP = Math.round(propS * hz);
  const propAmp = (targetImpulse * Math.PI) / (2 * propS);
  for (let i = 0; i < nP; i++) {
    push(bw + propAmp * Math.sin((Math.PI * i) / nP));
  }

  // rapid unload to takeoff then flight
  const nDrop = Math.round(dropS * hz);
  for (let i = 0; i < nDrop; i++) push(bw * (1 - i / nDrop) * 0.4);
  for (let i = 0; i < flightS * hz; i++) force.push(Math.max(0, noise() * 0.5));

  // landing spike (for display realism)
  const nL = Math.round(0.15 * hz);
  for (let i = 0; i < nL; i++) {
    push(bw + 1.8 * bw * Math.sin((Math.PI * i) / nL));
  }
  for (let i = 0; i < 0.3 * hz; i++) push(bw);

  // per-side split with a small time-varying wobble
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < force.length; i++) {
    const wobble = (rand() - 0.5) * 0.01;
    const share = Math.min(0.95, Math.max(0.05, p.leftShare + wobble));
    left.push(force[i] * share);
    right.push(force[i] * (1 - share));
  }

  return { hz, force, left, right };
}

export interface ImtpParams {
  massKg: number;
  /** peak NET force above BW, N */
  peakNetForceN: number;
  /** time constant of force rise, s (smaller = faster RFD) */
  riseTau: number;
  leftShare: number;
  seed: number;
  hz?: number;
}

/**
 * IMTP trace: quiet standing then an exponential rise to plateau
 * F(t) = BW + peakNet · (1 − e^(−t/τ)), held ~3 s.
 */
export function generateImtpTrace(p: ImtpParams): ForceTimeSeries {
  const hz = p.hz ?? 1000;
  const rand = rng(p.seed);
  const bw = p.massKg * GRAVITY;
  const noise = () => (rand() - 0.5) * 6;

  const force: number[] = [];
  for (let i = 0; i < 1.5 * hz; i++) force.push(bw + noise());
  const pullS = 3.0;
  for (let i = 0; i < pullS * hz; i++) {
    const t = i / hz;
    force.push(bw + p.peakNetForceN * (1 - Math.exp(-t / p.riseTau)) + noise());
  }
  for (let i = 0; i < 0.5 * hz; i++) {
    force.push(bw + p.peakNetForceN * Math.exp(-i / (0.1 * hz)) + noise());
  }

  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < force.length; i++) {
    const wobble = (rand() - 0.5) * 0.008;
    const share = Math.min(0.95, Math.max(0.05, p.leftShare + wobble));
    left.push(force[i] * share);
    right.push(force[i] * (1 - share));
  }
  return { hz, force, left, right };
}

export interface DjParams {
  massKg: number;
  contactTimeS: number;
  flightTimeS: number;
  seed: number;
  hz?: number;
}

/** Drop jump trace beginning mid-air from the drop: contact → takeoff → flight → landing. */
export function generateDjTrace(p: DjParams): ForceTimeSeries {
  const hz = p.hz ?? 1000;
  const rand = rng(p.seed);
  const bw = p.massKg * GRAVITY;
  const noise = () => (rand() - 0.5) * 6;
  const force: number[] = [];
  // falling from drop box
  for (let i = 0; i < 0.25 * hz; i++) force.push(Math.max(0, noise() * 0.3));
  // ground contact: high half-sine
  const nC = Math.round(p.contactTimeS * hz);
  for (let i = 0; i < nC; i++) force.push(Math.max(0, bw + 2.4 * bw * Math.sin((Math.PI * i) / nC) + noise()));
  // flight
  for (let i = 0; i < p.flightTimeS * hz; i++) force.push(Math.max(0, noise() * 0.3));
  // landing
  const nL = Math.round(0.2 * hz);
  for (let i = 0; i < nL; i++) force.push(Math.max(0, bw + 1.6 * bw * Math.sin((Math.PI * i) / nL) + noise()));
  for (let i = 0; i < 0.2 * hz; i++) force.push(bw + noise());
  return { hz, force };
}

/** Downsample a series for display storage (keeps shape, shrinks payload). */
export function downsample(series: ForceTimeSeries, targetHz: number): ForceTimeSeries {
  const factor = Math.max(1, Math.round(series.hz / targetHz));
  const pick = (xs: number[]) => xs.filter((_, i) => i % factor === 0);
  return {
    hz: series.hz / factor,
    force: pick(series.force),
    left: series.left ? pick(series.left) : undefined,
    right: series.right ? pick(series.right) : undefined,
  };
}
