/**
 * IMTP Force 0–300 ms window — trainer-facing summary assembly.
 *
 * Pure, deterministic module: takes already-queried metric series (persisted
 * official metric rows — never re-sampled from a display waveform) and builds
 * one summary row per fixed time point. All cross-series alignment rules live
 * here, not in React:
 *
 *  - The latest ABSOLUTE bilateral value anchors the row. Relative, left and
 *    right values are only reported when they come from that same session
 *    date — values from different sessions are never mixed into one row.
 *  - Asymmetry (%) and stronger side are reported only when a persisted
 *    asymmetry point exists for the anchor date (i.e. genuine bilateral data).
 *  - Side changes count left↔right flips across the FULL asymmetry history
 *    via the shared directionChanges() rule; null when fewer than two
 *    bilateral sessions exist (a count of 0 would overstate stability).
 */

import { directionChanges } from "./asymmetry";

export interface SeriesPoint {
  date: string;
  value: number;
  sessionId?: string;
}

export interface AsymmetrySeriesPoint {
  date: string;
  value: number;
  strongerSide: "left" | "right" | "equal";
}

export interface ForceWindowRowInput {
  ms: number;
  metricKey: string;
  /** bilateral absolute force series (N), session-best, ascending by date */
  abs: SeriesPoint[];
  /** bilateral body-mass-normalized series (N/kg) */
  rel: SeriesPoint[];
  /** per-side absolute series — empty when no dual-plate data exists */
  left: SeriesPoint[];
  right: SeriesPoint[];
  /** persisted asymmetry-index history for this source metric */
  asymmetry: AsymmetrySeriesPoint[];
}

export interface ForceWindowRow {
  ms: number;
  metricKey: string;
  /** date of the session the displayed values come from */
  latestDate: string | null;
  absN: number | null;
  relNkg: number | null;
  leftN: number | null;
  rightN: number | null;
  asymmetryPct: number | null;
  strongerSide: "left" | "right" | "equal" | null;
  /** left↔right flips across the full bilateral history; null when < 2 bilateral sessions */
  sideChanges: number | null;
  /** number of sessions with a bilateral absolute value for this point */
  sessionCount: number;
}

function latest(series: SeriesPoint[]): SeriesPoint | null {
  return series.length ? series[series.length - 1] : null;
}

/** Latest value only if it belongs to the anchor date — never mix sessions in one row. */
function valueOn(series: SeriesPoint[], date: string): number | null {
  const p = latest(series);
  return p && p.date === date ? p.value : null;
}

export function buildForceWindowRow(input: ForceWindowRowInput): ForceWindowRow {
  const anchor = latest(input.abs);
  if (!anchor) {
    return {
      ms: input.ms,
      metricKey: input.metricKey,
      latestDate: null,
      absN: null,
      relNkg: null,
      leftN: null,
      rightN: null,
      asymmetryPct: null,
      strongerSide: null,
      sideChanges: null,
      sessionCount: 0,
    };
  }

  const asymLatest = input.asymmetry.length ? input.asymmetry[input.asymmetry.length - 1] : null;
  const asymOnAnchor = asymLatest && asymLatest.date === anchor.date ? asymLatest : null;

  return {
    ms: input.ms,
    metricKey: input.metricKey,
    latestDate: anchor.date,
    absN: anchor.value,
    relNkg: valueOn(input.rel, anchor.date),
    leftN: valueOn(input.left, anchor.date),
    rightN: valueOn(input.right, anchor.date),
    asymmetryPct: asymOnAnchor ? asymOnAnchor.value : null,
    strongerSide: asymOnAnchor ? asymOnAnchor.strongerSide : null,
    sideChanges: input.asymmetry.length >= 2 ? directionChanges(input.asymmetry) : null,
    sessionCount: input.abs.length,
  };
}
