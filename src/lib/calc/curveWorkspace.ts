/**
 * Force-time curve workspace — deterministic selection, validity, alignment,
 * interpolation and averaging. React components only draw what this module
 * prepares; no curve math lives in the UI.
 *
 * Contract (docs/METHODOLOGY.md):
 *  - Time 0 = the detected reference event (CMJ movement onset, IMTP force
 *    onset); display begins CURVE_DISPLAY_LEAD_MS (20 ms) before it.
 *  - Alignment uses the persisted full-rate-derived event markers stored per
 *    trial — never positions re-detected from the downsampled display copy.
 *  - Only valid attempts participate: no quality flag, a stored waveform,
 *    and markers of the matching kind. Everything else is excluded WITH a
 *    reason, never silently dropped.
 *  - Averages combine only compatible attempts (same display sample rate),
 *    over the overlapping aligned window only — curves are never stretched,
 *    extrapolated, or fabricated to fill a longer window, and a rolling
 *    window with fewer valid attempts than requested is labeled as such,
 *    never silently substituted.
 *  - Interpolation: each curve is resampled onto a grid anchored at time 0
 *    (its own display rate) by linear interpolation between adjacent stored
 *    samples, strictly inside its own recorded domain.
 */

import { EventMarkers, originMs, CURVE_DISPLAY_LEAD_MS } from "./curve";

export interface DisplayWaveform {
  hz: number;
  force: number[];
  left?: number[];
  right?: number[];
}

export interface AttemptRecord {
  trialId: string;
  sessionId: string;
  date: string;
  trialNumber: number;
  qualityFlag: string | null;
  waveform: DisplayWaveform | null;
  markers: EventMarkers | null;
}

export interface ExcludedAttempt {
  trialId: string;
  date: string;
  trialNumber: number;
  reason: string;
}

const byDateAndTrial = (a: AttemptRecord, b: AttemptRecord) =>
  a.date === b.date ? a.trialNumber - b.trialNumber : a.date < b.date ? -1 : 1;

/** Split attempts into valid (usable for curves) and excluded-with-reason. */
export function classifyAttempts(
  kind: "cmj" | "imtp",
  attempts: AttemptRecord[]
): { valid: AttemptRecord[]; excluded: ExcludedAttempt[] } {
  const valid: AttemptRecord[] = [];
  const excluded: ExcludedAttempt[] = [];
  for (const a of [...attempts].sort(byDateAndTrial)) {
    const reason = a.qualityFlag
      ? `quality flag: ${a.qualityFlag}`
      : !a.waveform || a.waveform.force.length === 0
        ? "no stored waveform"
        : !a.markers
          ? "no alignment markers (trial predates the marker contract)"
          : a.markers.kind !== kind
            ? `marker kind '${a.markers.kind}' does not match test '${kind}'`
            : null;
    if (reason) excluded.push({ trialId: a.trialId, date: a.date, trialNumber: a.trialNumber, reason });
    else valid.push(a);
  }
  return { valid, excluded };
}

/* ------------------------------------------------------------------ */
/* Alignment + interpolation                                           */
/* ------------------------------------------------------------------ */

export interface AlignedCurve {
  trialId: string;
  date: string;
  trialNumber: number;
  hz: number;
  stepMs: number;
  /** time of the first sample relative to the reference event (≤ 0) */
  startMs: number;
  force: number[];
  left?: number[];
  right?: number[];
}

/** Linear interpolation of a stored series at an absolute recording time (ms). Caller keeps t inside the domain. */
function sampleAt(arr: number[], hz: number, tAbsMs: number): number {
  const pos = (tAbsMs / 1000) * hz;
  const i = Math.floor(pos);
  if (i < 0) return arr[0];
  if (i >= arr.length - 1) return arr[arr.length - 1];
  const frac = pos - i;
  return arr[i] * (1 - frac) + arr[i + 1] * frac;
}

/**
 * Resample one valid attempt onto a grid anchored at time 0 = its detected
 * onset, from −20 ms (or the start of the recording, whichever is later) to
 * the end of its recording. Grid step = the display waveform's own rate.
 */
export function alignAttempt(a: AttemptRecord): AlignedCurve {
  if (!a.waveform || !a.markers) throw new Error("alignAttempt requires a valid attempt (waveform + markers)");
  const { hz, force, left, right } = a.waveform;
  const stepMs = 1000 / hz;
  const origin = originMs(a.markers);
  const durMs = ((force.length - 1) / hz) * 1000;
  const kMin = -Math.floor(Math.min(CURVE_DISPLAY_LEAD_MS, origin) / stepMs);
  const kMax = Math.floor((durMs - origin) / stepMs);
  const grid = (arr: number[]) => {
    const out: number[] = [];
    for (let k = kMin; k <= kMax; k++) out.push(sampleAt(arr, hz, origin + k * stepMs));
    return out;
  };
  const hasSides = !!(left && right && left.length === force.length && right.length === force.length);
  return {
    trialId: a.trialId,
    date: a.date,
    trialNumber: a.trialNumber,
    hz,
    stepMs,
    startMs: kMin * stepMs,
    force: grid(force),
    ...(hasSides ? { left: grid(left!), right: grid(right!) } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Averaging                                                           */
/* ------------------------------------------------------------------ */

export interface AveragedCurve {
  hz: number;
  stepMs: number;
  startMs: number;
  force: number[];
  left?: number[];
  right?: number[];
  included: { trialId: string; date: string; trialNumber: number }[];
}

/**
 * Point-wise mean of already-aligned curves over their OVERLAPPING window
 * only. All curves must share a sample rate (enforce compatibility upstream).
 * Per-side averages exist only when every included curve has bilateral data.
 */
export function averageAlignedCurves(curves: AlignedCurve[]): AveragedCurve {
  if (curves.length === 0) throw new Error("averageAlignedCurves requires at least one curve");
  const hz = curves[0].hz;
  if (curves.some((c) => c.hz !== hz)) {
    throw new Error("averageAlignedCurves requires a uniform sample rate — filter incompatible attempts first");
  }
  const stepMs = 1000 / hz;
  const kMinOf = (c: AlignedCurve) => Math.round(c.startMs / stepMs);
  const kMaxOf = (c: AlignedCurve) => kMinOf(c) + c.force.length - 1;
  const kMin = Math.max(...curves.map(kMinOf));
  const kMax = Math.min(...curves.map(kMaxOf));
  if (kMax < kMin) throw new Error("curves share no overlapping aligned window");

  const allBilateral = curves.every((c) => c.left && c.right);
  const mean = (pick: (c: AlignedCurve) => number[]) => {
    const out: number[] = [];
    for (let k = kMin; k <= kMax; k++) {
      let sum = 0;
      for (const c of curves) sum += pick(c)[k - kMinOf(c)];
      out.push(sum / curves.length);
    }
    return out;
  };

  return {
    hz,
    stepMs,
    startMs: kMin * stepMs,
    force: mean((c) => c.force),
    ...(allBilateral ? { left: mean((c) => c.left!), right: mean((c) => c.right!) } : {}),
    included: curves.map((c) => ({ trialId: c.trialId, date: c.date, trialNumber: c.trialNumber })),
  };
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

export const ROLLING_WINDOWS = [5, 10, 30] as const;
export const MAX_OVERLAID_CURVES = 3;

export type CurveSelection =
  | { mode: "attempt"; trialId: string }
  | { mode: "rolling"; window: number }
  | { mode: "alltime" };

/** Parse a URL-safe selection token: "attempt:<trialId>" | "rolling:<5|10|30>" | "alltime". */
export function parseCurveSelection(s: string | undefined | null): CurveSelection | null {
  if (!s) return null;
  if (s === "alltime") return { mode: "alltime" };
  if (s.startsWith("attempt:") && s.length > 8) return { mode: "attempt", trialId: s.slice(8) };
  if (s.startsWith("rolling:")) {
    const w = Number(s.slice(8));
    if ((ROLLING_WINDOWS as readonly number[]).includes(w)) return { mode: "rolling", window: w };
  }
  return null;
}

export function selectionToken(sel: CurveSelection): string {
  return sel.mode === "attempt" ? `attempt:${sel.trialId}` : sel.mode === "rolling" ? `rolling:${sel.window}` : "alltime";
}

export interface PreparedCurve {
  token: string;
  label: string;
  kind: "individual" | "average";
  hz: number;
  stepMs: number;
  startMs: number;
  force: number[];
  left?: number[];
  right?: number[];
  /** individual curves only */
  trialId?: string;
  date?: string;
  trialNumber?: number;
  /** attempts actually averaged (1 for individual) */
  includedCount: number;
  included: { trialId: string; date: string; trialNumber: number }[];
  /** rolling only: the window size the trainer asked for */
  requestedCount?: number;
  /** true when fewer valid attempts exist than requested — labeled, never silent */
  insufficient?: boolean;
  /** attempts dropped from THIS average for compatibility, with reasons */
  excluded: ExcludedAttempt[];
}

/**
 * Resolve one selection against the valid-attempt list. Returns null when the
 * selection cannot be satisfied at all (unknown trial, or no valid attempts).
 */
export function prepareCurve(valid: AttemptRecord[], sel: CurveSelection): PreparedCurve | null {
  const sorted = [...valid].sort(byDateAndTrial);
  if (sel.mode === "attempt") {
    const a = sorted.find((x) => x.trialId === sel.trialId);
    if (!a) return null;
    const c = alignAttempt(a);
    return {
      token: selectionToken(sel),
      label: `${a.date} · attempt ${a.trialNumber}`,
      kind: "individual",
      hz: c.hz,
      stepMs: c.stepMs,
      startMs: c.startMs,
      force: c.force,
      left: c.left,
      right: c.right,
      trialId: a.trialId,
      date: a.date,
      trialNumber: a.trialNumber,
      includedCount: 1,
      included: [{ trialId: a.trialId, date: a.date, trialNumber: a.trialNumber }],
      excluded: [],
    };
  }

  if (sorted.length === 0) return null;
  const pool = sel.mode === "rolling" ? sorted.slice(-sel.window) : sorted;

  // Compatibility: average at the most recent attempt's sample rate only.
  const targetHz = pool[pool.length - 1].waveform!.hz;
  const compatible: AttemptRecord[] = [];
  const excluded: ExcludedAttempt[] = [];
  for (const a of pool) {
    if (a.waveform!.hz === targetHz) compatible.push(a);
    else
      excluded.push({
        trialId: a.trialId,
        date: a.date,
        trialNumber: a.trialNumber,
        reason: `display sample rate ${a.waveform!.hz} Hz differs from ${targetHz} Hz`,
      });
  }
  const avg = averageAlignedCurves(compatible.map(alignAttempt));

  const insufficient = sel.mode === "rolling" && sorted.length < sel.window;
  const label =
    sel.mode === "rolling"
      ? insufficient
        ? `Average of all ${avg.included.length} valid attempts (fewer than the ${sel.window} requested)`
        : excluded.length > 0
          ? `Rolling average — ${avg.included.length} of last ${sel.window} valid attempts (rate-incompatible attempts excluded)`
          : `Rolling average — last ${sel.window} valid attempts`
      : `All-time average — ${avg.included.length} valid attempts`;

  return {
    token: selectionToken(sel),
    label,
    kind: "average",
    hz: avg.hz,
    stepMs: avg.stepMs,
    startMs: avg.startMs,
    force: avg.force,
    left: avg.left,
    right: avg.right,
    includedCount: avg.included.length,
    included: avg.included,
    ...(sel.mode === "rolling" ? { requestedCount: sel.window, insufficient } : {}),
    excluded,
  };
}
