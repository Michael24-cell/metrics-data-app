/**
 * Adapter contract — every data path into the platform implements this shape:
 *   inspect → map_to_canonical → validate → import_raw → compute_metrics → generate_outputs
 *
 * Operational in V1: synthetic_signal, csv_generic, manual_entry, demo_dataset.
 * Interface-defined stubs (no credentials, no network): vendor force-plate /
 * VBT APIs. Stubs throw AdapterNotOperationalError from every stage.
 */

import { ForceTimeSeries } from "../calc/signal";

/** The only side values the platform accepts anywhere metric data is written. */
export const VALID_SIDES = ["left", "right", "bilateral"] as const;
export type Side = (typeof VALID_SIDES)[number];

export function isValidSide(value: string): value is Side {
  return (VALID_SIDES as readonly string[]).includes(value);
}

export interface InspectReport {
  adapterKey: string;
  ok: boolean;
  detectedFormat?: string;
  columns?: string[];
  rowCount?: number;
  issues: string[];
}

/** Canonical payload: what every adapter must map its input into. */
export interface CanonicalSession {
  athleteId: string;
  testType: string; // key into TEST_TYPES
  sessionDate: string; // ISO date
  deviceId?: string;
  notes?: string;
  trials: CanonicalTrial[];
}

export interface CanonicalTrial {
  trialNumber: number;
  /** full-rate waveform when available — metrics computed from it */
  waveform?: ForceTimeSeries;
  /** pre-computed metric values when no waveform exists (manual/CSV entry) */
  metrics?: { metricType: string; side: "left" | "right" | "bilateral"; value: number }[];
  rawMeta?: Record<string, unknown>;
}

export interface CanonicalPayload {
  sessions: CanonicalSession[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ImportResult {
  sessionIds: string[];
  trialIds: string[];
}

export interface ComputeResult {
  metricCount: number;
  failedTrials: { trialId: string; reason: string }[];
}

export interface OutputsResult {
  findingsGenerated: number;
}

export interface Adapter<TInput = unknown> {
  key: string;
  label: string;
  kind: "operational" | "stub";
  inspect(input: TInput): InspectReport;
  mapToCanonical(input: TInput, facilityId: string): CanonicalPayload;
  validate(payload: CanonicalPayload, facilityId: string): ValidationResult;
  importRaw(payload: CanonicalPayload, facilityId: string, batchId: string): ImportResult;
  computeMetrics(sessionIds: string[], facilityId: string): ComputeResult;
  generateOutputs(athleteIds: string[], facilityId: string): OutputsResult;
}

export class AdapterNotOperationalError extends Error {
  constructor(adapterKey: string) {
    super(
      `Adapter '${adapterKey}' is interface-defined only in V1. It requires vendor credentials and a live API agreement; see ROADMAP.md.`
    );
    this.name = "AdapterNotOperationalError";
  }
}
