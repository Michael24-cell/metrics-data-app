/**
 * Concrete adapters. All share importCanonical/computeCanonical/generateCanonical
 * so every data path lands in the same schema and metric functions.
 */

import { getDb, newId, nowIso } from "../db/db";
import { getAthlete } from "../db/dal";
import { METRICS, TEST_TYPES, metricDef } from "../config/metrics";
import {
  Adapter,
  AdapterNotOperationalError,
  CanonicalPayload,
  CanonicalTrial,
  ComputeResult,
  ImportResult,
  InspectReport,
  isValidSide,
  OutputsResult,
  ValidationResult,
  VALID_SIDES,
} from "./adapter";
import { computeTrialMetrics, computeSessionAsymmetry, insertMetric } from "./compute";
import { downsample } from "../calc/synthetic";
import { regenerateFindings } from "../findings/engine";
import { ForceTimeSeries } from "../calc/signal";
import {
  protocolForTestType,
  validateProtocolAttempt,
  validateProtocolSession,
} from "../protocols/registry";

/* ------------------------------------------------------------------ */
/* Shared canonical stages                                             */
/* ------------------------------------------------------------------ */

export function validateCanonical(payload: CanonicalPayload, facilityId: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const s of payload.sessions) {
    if (!getAthlete(facilityId, s.athleteId)) {
      errors.push(`Athlete ${s.athleteId} not found in this facility — rows for other facilities are rejected, not silently imported.`);
    }
    if (!TEST_TYPES[s.testType]) errors.push(`Unknown test type '${s.testType}'.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.sessionDate)) errors.push(`Bad session date '${s.sessionDate}'.`);
    const protocol = protocolForTestType(s.testType);
    if (protocol) {
      if (s.protocolId && s.protocolId !== protocol.id) {
        errors.push(
          `Protocol '${s.protocolId}' does not match test type '${s.testType}' (${protocol.id} required).`
        );
      }
      if (s.protocolVersion != null && s.protocolVersion !== protocol.version) {
        errors.push(
          `Protocol version ${s.protocolVersion} is not registered for '${s.testType}' (${protocol.version} required).`
        );
      }
      errors.push(
        ...validateProtocolSession(protocol, {
          athleteId: s.athleteId,
          sessionDate: s.sessionDate,
          setupVariant: s.setupVariant,
          setupMetadata: s.setupMetadata,
        })
          .filter((issue) => issue.blocksApproval)
          .map((issue) => `${issue.code}: ${issue.message}`)
      );
    } else if (s.protocolId || s.protocolVersion != null || s.setupVariant || s.setupMetadata) {
      errors.push(`Test type '${s.testType}' has no implemented protocol contract.`);
    }
    if (s.trials.length === 0) warnings.push(`Session on ${s.sessionDate} has no trials.`);
    for (const t of s.trials) {
      if (!t.waveform && (!t.metrics || t.metrics.length === 0)) {
        errors.push(`Trial ${t.trialNumber} (${s.sessionDate}) has neither waveform nor metric values.`);
      }
      for (const m of t.metrics ?? []) {
        if (!isValidSide(m.side)) {
          errors.push(
            `Invalid side '${m.side}' for ${m.metricType} on ${s.sessionDate} (trial ${t.trialNumber}) — must be one of ${VALID_SIDES.join(", ")}.`
          );
        }
        if (!METRICS[m.metricType]) {
          errors.push(`Unknown metric_type '${m.metricType}'.`);
        } else if (protocol && !protocol.metrics.officialMetricKeys.includes(m.metricType)) {
          errors.push(
            `Metric '${m.metricType}' is not declared by ${protocol.id}@${protocol.version}.`
          );
        } else if (!Number.isFinite(m.value)) {
          errors.push(
            `Non-numeric or missing value for ${m.metricType} on ${s.sessionDate} (trial ${t.trialNumber}).`
          );
        } else {
          const def = metricDef(m.metricType);
          if (m.value < def.sanity.min || m.value > def.sanity.max) {
            warnings.push(
              `${def.shortLabel} value ${m.value}${def.unit} on ${s.sessionDate} is outside the plausible range [${def.sanity.min}–${def.sanity.max}] and will be quality-flagged.`
            );
          }
        }
      }
      if (t.waveform && t.waveform.force.length < t.waveform.hz) {
        warnings.push(`Trial ${t.trialNumber} waveform is under 1 s — may be unscoreable.`);
      }
      if (protocol && t.waveform) {
        const attemptIssues = validateProtocolAttempt(protocol, t.waveform);
        errors.push(
          ...attemptIssues
            .filter((issue) => issue.blocksApproval)
            .map((issue) => `${issue.code}: ${issue.message}`)
        );
        warnings.push(
          ...attemptIssues
            .filter((issue) => !issue.blocksApproval)
            .map((issue) => `${issue.code}: ${issue.message}`)
        );
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Full-rate waveforms are kept in memory for compute; a downsampled copy is stored for display. */
const waveformCache = new Map<string, ForceTimeSeries>();

export function importCanonical(
  payload: CanonicalPayload,
  facilityId: string,
  batchId: string
): ImportResult {
  const db = getDb();
  const sessionIds: string[] = [];
  const trialIds: string[] = [];
  for (const s of payload.sessions) {
    const protocol = protocolForTestType(s.testType);
    const protocolId = protocol?.id ?? null;
    const protocolVersion = protocol?.version ?? null;
    const calculationVersion = protocol?.calculationVersion ?? null;
    const setupVariant = protocol ? (s.setupVariant ?? protocol.defaultSetupVariant) : null;
    const setupMetadata = protocol ? JSON.stringify(s.setupMetadata ?? {}) : null;
    const sessionId = newId();
    db.prepare(
      `INSERT INTO session
       (id, facility_id, athlete_id, device_id, import_batch_id, test_type,
        protocol_id, protocol_version, calculation_version, setup_variant, setup_metadata_json,
        session_date, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId,
      facilityId,
      s.athleteId,
      s.deviceId ?? null,
      batchId,
      s.testType,
      protocolId,
      protocolVersion,
      calculationVersion,
      setupVariant,
      setupMetadata,
      s.sessionDate,
      s.notes ?? null,
      nowIso()
    );
    sessionIds.push(sessionId);
    for (const t of s.trials) {
      const trialId = newId();
      const display = t.waveform ? downsample(t.waveform, 250) : null;
      db.prepare(
        `INSERT INTO trial
         (id, facility_id, session_id, trial_number, protocol_id, protocol_version,
          calculation_version, setup_variant, raw_meta_json, waveform_json, quality_flag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        trialId,
        facilityId,
        sessionId,
        t.trialNumber,
        protocolId,
        protocolVersion,
        calculationVersion,
        setupVariant,
        t.rawMeta ? JSON.stringify(t.rawMeta) : null,
        display
          ? JSON.stringify({
              hz: display.hz,
              force: display.force.map((v) => Math.round(v * 10) / 10),
              left: display.left?.map((v) => Math.round(v * 10) / 10),
              right: display.right?.map((v) => Math.round(v * 10) / 10),
            })
          : null,
        null,
        nowIso()
      );
      trialIds.push(trialId);
      if (t.waveform) waveformCache.set(trialId, t.waveform);
      // direct metric values (manual/CSV path) are inserted at import as source rows
      if (t.metrics) {
        for (const m of t.metrics) {
          insertMetric(facilityId, s.athleteId, sessionId, {
            metricType: m.metricType,
            side: m.side,
            value: m.value,
            trialId,
            methodVersion: "imported",
            source: "imported",
          });
        }
      }
    }
  }
  return { sessionIds, trialIds };
}

export function computeCanonical(sessionIds: string[], facilityId: string): ComputeResult {
  const db = getDb();
  let metricCount = 0;
  const failedTrials: { trialId: string; reason: string }[] = [];
  for (const sessionId of sessionIds) {
    const session = db
      .prepare(`SELECT * FROM session WHERE facility_id = ? AND id = ?`)
      .get(facilityId, sessionId) as { athlete_id: string; test_type: string } | undefined;
    if (!session) continue;
    const trials = db
      .prepare(`SELECT id FROM trial WHERE facility_id = ? AND session_id = ?`)
      .all(facilityId, sessionId) as { id: string }[];
    for (const t of trials) {
      const wf = waveformCache.get(t.id);
      if (!wf) continue; // metric-only trials were inserted at import
      try {
        metricCount += computeTrialMetrics(
          facilityId,
          session.athlete_id,
          sessionId,
          t.id,
          session.test_type,
          wf
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        failedTrials.push({ trialId: t.id, reason });
        db.prepare(`UPDATE trial SET quality_flag = ? WHERE id = ?`).run(`unscoreable: ${reason}`, t.id);
      } finally {
        waveformCache.delete(t.id);
      }
    }
    metricCount += computeSessionAsymmetry(facilityId, session.athlete_id, sessionId);
  }
  return { metricCount, failedTrials };
}

export function generateCanonical(athleteIds: string[], facilityId: string): OutputsResult {
  let findings = 0;
  for (const athleteId of [...new Set(athleteIds)]) {
    findings += regenerateFindings(facilityId, athleteId);
  }
  return { findingsGenerated: findings };
}

/* ------------------------------------------------------------------ */
/* Synthetic signal adapter (operational)                              */
/* ------------------------------------------------------------------ */

export interface SyntheticInput {
  sessions: {
    athleteId: string;
    testType: string;
    sessionDate: string;
    deviceId?: string;
    notes?: string;
    trials: { trialNumber: number; waveform: ForceTimeSeries }[];
  }[];
}

export const syntheticSignalAdapter: Adapter<SyntheticInput> = {
  key: "synthetic_signal",
  label: "Synthetic Signal Generator",
  kind: "operational",
  inspect(input) {
    return {
      adapterKey: this.key,
      ok: input.sessions.length > 0,
      detectedFormat: "synthetic force-time series (1000 Hz)",
      rowCount: input.sessions.reduce((a, s) => a + s.trials.length, 0),
      issues: [],
    };
  },
  mapToCanonical(input) {
    return {
      sessions: input.sessions.map((s) => ({
        athleteId: s.athleteId,
        testType: s.testType,
        sessionDate: s.sessionDate,
        deviceId: s.deviceId,
        notes: s.notes,
        trials: s.trials.map((t) => ({ trialNumber: t.trialNumber, waveform: t.waveform })),
      })),
    };
  },
  validate: validateCanonical,
  importRaw: importCanonical,
  computeMetrics: computeCanonical,
  generateOutputs: generateCanonical,
};

/* ------------------------------------------------------------------ */
/* Generic CSV adapter (operational, session-level metric values)      */
/* ------------------------------------------------------------------ */

export interface CsvInput {
  filename: string;
  content: string;
  /** column mapping: canonical field -> CSV header */
  mapping?: Record<string, string>;
}

const CSV_CANONICAL_FIELDS = ["athlete_id", "test_type", "session_date", "metric_type", "side", "value"];

export function parseCsv(content: string): { headers: string[]; rows: string[][] } {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const split = (line: string) => line.split(",").map((c) => c.trim());
  return { headers: split(lines[0]), rows: lines.slice(1).map(split) };
}

export const csvGenericAdapter: Adapter<CsvInput> = {
  key: "csv_generic",
  label: "Generic CSV Mapper",
  kind: "operational",
  inspect(input) {
    const { headers, rows } = parseCsv(input.content);
    const issues: string[] = [];
    const mapping = input.mapping ?? Object.fromEntries(CSV_CANONICAL_FIELDS.map((f) => [f, f]));
    for (const f of CSV_CANONICAL_FIELDS) {
      if (f === "side") continue; // optional, defaults to bilateral
      if (!headers.includes(mapping[f] ?? f)) issues.push(`Missing required column '${mapping[f] ?? f}' (maps to ${f}).`);
    }
    return {
      adapterKey: this.key,
      ok: issues.length === 0,
      detectedFormat: "delimited text (comma)",
      columns: headers,
      rowCount: rows.length,
      issues,
    };
  },
  mapToCanonical(input) {
    const { headers, rows } = parseCsv(input.content);
    const mapping = input.mapping ?? Object.fromEntries(CSV_CANONICAL_FIELDS.map((f) => [f, f]));
    const col = (name: string) => headers.indexOf(mapping[name] ?? name);
    const idx = {
      athlete: col("athlete_id"),
      test: col("test_type"),
      date: col("session_date"),
      metric: col("metric_type"),
      side: col("side"),
      value: col("value"),
    };
    // group rows into sessions by athlete+test+date
    const sessions = new Map<
      string,
      { athleteId: string; testType: string; sessionDate: string; trials: CanonicalTrial[] }
    >();
    for (const r of rows) {
      const key = `${r[idx.athlete]}|${r[idx.test]}|${r[idx.date]}`;
      if (!sessions.has(key)) {
        sessions.set(key, {
          athleteId: r[idx.athlete],
          testType: r[idx.test],
          sessionDate: r[idx.date],
          trials: [{ trialNumber: 1, metrics: [] }],
        });
      }
      // side column is optional (absent → bilateral); if present, the cell is
      // taken as-is (including blank) so validation can catch bad/missing
      // values instead of a default silently masking them.
      const side = idx.side >= 0 ? r[idx.side] ?? "" : "bilateral";
      const rawValue = r[idx.value];
      const value = rawValue == null || rawValue.trim() === "" ? NaN : Number(rawValue);
      sessions.get(key)!.trials[0].metrics!.push({
        metricType: r[idx.metric],
        side: side as "left" | "right" | "bilateral",
        value,
      });
    }
    return { sessions: [...sessions.values()] };
  },
  validate: validateCanonical,
  importRaw: importCanonical,
  computeMetrics: computeCanonical, // derives asymmetry from imported sided values
  generateOutputs: generateCanonical,
};

/* ------------------------------------------------------------------ */
/* Manual entry adapter (operational)                                  */
/* ------------------------------------------------------------------ */

export interface ManualInput {
  athleteId: string;
  testType: string;
  protocolId?: string;
  protocolVersion?: number;
  setupVariant?: string;
  setupMetadata?: Record<string, unknown>;
  sessionDate: string;
  notes?: string;
  metrics: { metricType: string; side: "left" | "right" | "bilateral"; value: number }[];
}

export const manualEntryAdapter: Adapter<ManualInput> = {
  key: "manual_entry",
  label: "Manual Entry",
  kind: "operational",
  inspect(input) {
    return {
      adapterKey: this.key,
      ok: input.metrics.length > 0,
      detectedFormat: "practitioner form entry",
      rowCount: input.metrics.length,
      issues: input.metrics.length === 0 ? ["No metric values entered."] : [],
    };
  },
  mapToCanonical(input) {
    return {
      sessions: [
        {
          athleteId: input.athleteId,
          testType: input.testType,
          protocolId: input.protocolId,
          protocolVersion: input.protocolVersion,
          setupVariant: input.setupVariant,
          setupMetadata: input.setupMetadata,
          sessionDate: input.sessionDate,
          notes: input.notes,
          trials: [{ trialNumber: 1, metrics: input.metrics }],
        },
      ],
    };
  },
  validate: validateCanonical,
  importRaw: importCanonical,
  computeMetrics: computeCanonical,
  generateOutputs: generateCanonical,
};

/* ------------------------------------------------------------------ */
/* Public/demo dataset adapter (operational)                           */
/* ------------------------------------------------------------------ */

/**
 * Consumes the bundled demo dataset (JSON of session-level metric values,
 * shaped like a typical public jump-testing export). Same canonical path.
 */
export interface DemoDatasetInput {
  dataset: {
    athleteId: string;
    testType: string;
    sessionDate: string;
    values: { metricType: string; side?: "left" | "right" | "bilateral"; value: number }[];
  }[];
}

export const demoDatasetAdapter: Adapter<DemoDatasetInput> = {
  key: "demo_dataset",
  label: "Public/Demo Dataset",
  kind: "operational",
  inspect(input) {
    return {
      adapterKey: this.key,
      ok: input.dataset.length > 0,
      detectedFormat: "bundled demo dataset (JSON)",
      rowCount: input.dataset.length,
      issues: [],
    };
  },
  mapToCanonical(input) {
    return {
      sessions: input.dataset.map((d) => ({
        athleteId: d.athleteId,
        testType: d.testType,
        sessionDate: d.sessionDate,
        trials: [
          {
            trialNumber: 1,
            metrics: d.values.map((v) => ({
              metricType: v.metricType,
              side: v.side ?? "bilateral",
              value: v.value,
            })),
          },
        ],
      })),
    };
  },
  validate: validateCanonical,
  importRaw: importCanonical,
  computeMetrics: computeCanonical,
  generateOutputs: generateCanonical,
};

/* ------------------------------------------------------------------ */
/* Vendor API stubs (interface-defined only, NOT operational)          */
/* ------------------------------------------------------------------ */

function makeVendorStub(key: string, label: string): Adapter<unknown> {
  const fail = () => {
    throw new AdapterNotOperationalError(key);
  };
  return {
    key,
    label,
    kind: "stub",
    inspect: fail as unknown as () => InspectReport,
    mapToCanonical: fail as unknown as () => CanonicalPayload,
    validate: fail as unknown as () => ValidationResult,
    importRaw: fail as unknown as () => ImportResult,
    computeMetrics: fail as unknown as () => ComputeResult,
    generateOutputs: fail as unknown as () => OutputsResult,
  };
}

export const vendorStubs: Adapter<unknown>[] = [
  makeVendorStub("forceplate_vendor_a_api", "Force Plate Vendor A (API)"),
  makeVendorStub("forceplate_vendor_b_api", "Force Plate Vendor B (API)"),
  makeVendorStub("vbt_vendor_api", "VBT Device Vendor (API)"),
];

export const ALL_ADAPTERS: Adapter<never>[] = [
  syntheticSignalAdapter as Adapter<never>,
  csvGenericAdapter as Adapter<never>,
  manualEntryAdapter as Adapter<never>,
  demoDatasetAdapter as Adapter<never>,
  ...(vendorStubs as Adapter<never>[]),
];

export function getAdapter(key: string): Adapter<never> {
  const a = ALL_ADAPTERS.find((x) => x.key === key);
  if (!a) throw new Error(`Unknown adapter '${key}'.`);
  return a;
}

/* ------------------------------------------------------------------ */
/* Batch runner: drives any adapter through all six stages             */
/* ------------------------------------------------------------------ */

export interface BatchRunResult {
  batchId: string;
  status: string;
  inspect: InspectReport;
  validation: ValidationResult;
  sessionIds: string[];
  metricCount: number;
  failedTrials: { trialId: string; reason: string }[];
  findingsGenerated: number;
}

export function runImportBatch<T>(
  adapter: Adapter<T>,
  input: T,
  facilityId: string,
  dataSourceId: string,
  filename?: string
): BatchRunResult {
  const db = getDb();
  const batchId = newId();
  db.prepare(
    `INSERT INTO import_batch (id, facility_id, data_source_id, status, filename, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  ).run(batchId, facilityId, dataSourceId, filename ?? null, nowIso());

  const setStatus = (status: string, extra: Record<string, unknown> = {}) => {
    db.prepare(
      `UPDATE import_batch SET status = ?, row_count = COALESCE(?, row_count), summary_json = COALESCE(?, summary_json), error_json = COALESCE(?, error_json), completed_at = ? WHERE id = ?`
    ).run(
      status,
      (extra.rowCount as number) ?? null,
      extra.summary ? JSON.stringify(extra.summary) : null,
      extra.error ? JSON.stringify(extra.error) : null,
      status === "complete" || status === "failed" ? nowIso() : null,
      batchId
    );
  };

  try {
    const inspect = adapter.inspect(input);
    setStatus("inspected", { rowCount: inspect.rowCount });
    if (!inspect.ok) {
      setStatus("failed", { error: { stage: "inspect", issues: inspect.issues } });
      return {
        batchId, status: "failed", inspect,
        validation: { ok: false, errors: inspect.issues, warnings: [] },
        sessionIds: [], metricCount: 0, failedTrials: [], findingsGenerated: 0,
      };
    }

    const payload = adapter.mapToCanonical(input, facilityId);
    const validation = adapter.validate(payload, facilityId);
    setStatus("validated");
    if (!validation.ok) {
      setStatus("failed", { error: { stage: "validate", errors: validation.errors } });
      return {
        batchId, status: "failed", inspect, validation,
        sessionIds: [], metricCount: 0, failedTrials: [], findingsGenerated: 0,
      };
    }

    const imported = adapter.importRaw(payload, facilityId, batchId);
    setStatus("imported");

    const computed = adapter.computeMetrics(imported.sessionIds, facilityId);
    setStatus("computed");

    const athleteIds = payload.sessions.map((s) => s.athleteId);
    const outputs = adapter.generateOutputs(athleteIds, facilityId);

    setStatus("complete", {
      summary: {
        sessions: imported.sessionIds.length,
        trials: imported.trialIds.length,
        metrics: computed.metricCount,
        failedTrials: computed.failedTrials,
        findings: outputs.findingsGenerated,
        warnings: validation.warnings,
      },
    });

    return {
      batchId,
      status: "complete",
      inspect,
      validation,
      sessionIds: imported.sessionIds,
      metricCount: computed.metricCount,
      failedTrials: computed.failedTrials,
      findingsGenerated: outputs.findingsGenerated,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setStatus("failed", { error: { stage: "run", message } });
    return {
      batchId, status: "failed",
      inspect: { adapterKey: adapter.key, ok: false, issues: [message] },
      validation: { ok: false, errors: [message], warnings: [] },
      sessionIds: [], metricCount: 0, failedTrials: [], findingsGenerated: 0,
    };
  }
}
