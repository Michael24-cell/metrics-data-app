/**
 * Force-time curve alignment contract — foundation only.
 *
 * This module defines the common coordinate system future curve overlays
 * will share: time 0 = the detected reference event (CMJ movement onset,
 * IMTP force onset), with the display window beginning 20 ms before it.
 * Event markers are derived here from the SAME full-rate calculation
 * results used for each trial's official metrics — never recomputed from
 * the persisted (lower-rate) display waveform, and never backfilled onto
 * trials that predate this contract.
 *
 * Rolling-average and multi-attempt overlay logic are NOT implemented here
 * yet; this module only defines the shared origin/window so that future
 * work aligns curves consistently instead of inventing per-feature math.
 */

import { CmjResult } from "./cmj";
import { ImtpResult } from "./imtp";

/** Display window begins this many ms before the reference event. */
export const CURVE_DISPLAY_LEAD_MS = 20;

export interface CmjEventMarkers {
  kind: "cmj";
  methodVersion: string;
  /** ms from the start of the recorded trace to detected movement onset */
  movementStartMs: number;
  /** ms from the start of the recorded trace to detected takeoff */
  takeoffMs: number;
}

export interface ImtpEventMarkers {
  kind: "imtp";
  methodVersion: string;
  /** ms from the start of the recorded trace to detected force onset */
  onsetMs: number;
  /** ms from the start of the recorded trace to the peak-force sample */
  peakForceMs: number;
}

export type EventMarkers = CmjEventMarkers | ImtpEventMarkers;

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Derive CMJ event markers (ms) from a full-rate CmjResult + its sampling rate. */
export function cmjEventMarkers(r: CmjResult, hz: number): CmjEventMarkers {
  return {
    kind: "cmj",
    methodVersion: r.methodVersion,
    movementStartMs: round1((r.movementStartIndex / hz) * 1000),
    takeoffMs: round1((r.takeoffIndex / hz) * 1000),
  };
}

/** Derive IMTP event markers (ms) from a full-rate ImtpResult + its sampling rate. */
export function imtpEventMarkers(r: ImtpResult, hz: number): ImtpEventMarkers {
  return {
    kind: "imtp",
    methodVersion: r.methodVersion,
    onsetMs: round1((r.onsetIndex / hz) * 1000),
    peakForceMs: round1((r.peakForceIndex / hz) * 1000),
  };
}

/** The reference-event time (curve time-zero) for a marker set, ms from recording start. */
export function originMs(markers: EventMarkers): number {
  return markers.kind === "cmj" ? markers.movementStartMs : markers.onsetMs;
}

/** Where curve display should begin (ms from recording start), clamped to ≥0. */
export function displayStartMs(markers: EventMarkers): number {
  return Math.max(0, originMs(markers) - CURVE_DISPLAY_LEAD_MS);
}
