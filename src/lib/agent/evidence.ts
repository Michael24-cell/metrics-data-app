/**
 * Evidence ID scheme + facility/athlete-scoped resolver (server-only).
 *
 * Every evidence ref the agent emits is resolvable here, so the Evidence
 * Explorer can jump from a claim to the exact metric, session, finding,
 * criterion, threshold, note, or methodology entry behind it. Resolution is
 * scoped: an id belonging to another athlete or facility resolves to an
 * error, never to data.
 */

import { getDb } from "../db/db";
import { METRICS } from "../config/metrics";
import { EvidenceType } from "./schemas";

export interface ResolvedEvidence {
  ok: boolean;
  type: EvidenceType;
  id: string;
  title: string;
  detail: string;
  /** in-app link for the Evidence Explorer, when one exists */
  link?: string;
  record?: Record<string, unknown>;
  error?: string;
}

const fail = (type: EvidenceType, id: string, error: string): ResolvedEvidence => ({
  ok: false, type, id, title: "Not resolvable", detail: error, error,
});

export function resolveEvidence(
  facilityId: string,
  athleteId: string,
  type: EvidenceType,
  id: string
): ResolvedEvidence {
  const db = getDb();

  switch (type) {
    case "session": {
      const row = db
        .prepare(`SELECT * FROM session WHERE facility_id = ? AND athlete_id = ? AND id = ?`)
        .get(facilityId, athleteId, id) as Record<string, unknown> | undefined;
      if (!row) return fail(type, id, "Session not found for this athlete in this facility.");
      return {
        ok: true, type, id,
        title: `Session ${row.session_date} · ${row.test_type}`,
        detail: `Test session (${row.test_type}) on ${row.session_date}.`,
        link: `/sessions/${id}`,
        record: row,
      };
    }
    case "metric_value": {
      const row = db
        .prepare(`SELECT * FROM metric WHERE facility_id = ? AND athlete_id = ? AND id = ?`)
        .get(facilityId, athleteId, id) as Record<string, unknown> | undefined;
      if (!row) return fail(type, id, "Metric row not found for this athlete in this facility.");
      return {
        ok: true, type, id,
        title: `${row.metric_type} = ${row.value} ${row.unit}`,
        detail: `Computed metric (method v${row.method_version}, source ${row.source}).`,
        link: `/sessions/${row.session_id}`,
        record: row,
      };
    }
    case "finding": {
      const row = db
        .prepare(`SELECT * FROM finding WHERE facility_id = ? AND athlete_id = ? AND id = ?`)
        .get(facilityId, athleteId, id) as Record<string, unknown> | undefined;
      if (!row) return fail(type, id, "Finding not found for this athlete in this facility.");
      return {
        ok: true, type, id,
        title: String(row.headline),
        detail: String(row.detail),
        link: `/athletes/${athleteId}`,
        record: row,
      };
    }
    case "criterion": {
      // crit:<findingId>:<criterionId>
      const m = /^crit:([^:]+):(.+)$/.exec(id);
      if (!m) return fail(type, id, "Malformed criterion id.");
      const finding = db
        .prepare(`SELECT * FROM finding WHERE facility_id = ? AND athlete_id = ? AND id = ?`)
        .get(facilityId, athleteId, m[1]) as { refs_json: string } | undefined;
      if (!finding) return fail(type, id, "Parent criteria finding not found for this athlete.");
      const refs = JSON.parse(finding.refs_json) as { criteria?: { id: string; label: string; observed: string; target: string; met: boolean | null }[] };
      const crit = refs.criteria?.find((c) => c.id === m[2]);
      if (!crit) return fail(type, id, "Criterion not found on the finding.");
      return {
        ok: true, type, id,
        title: crit.label,
        detail: `Observed: ${crit.observed} · Target: ${crit.target} · Status: ${crit.met === null ? "not evaluated / documented separately" : crit.met ? "met" : "not yet met"}`,
        link: `/athletes/${athleteId}`,
        record: crit as unknown as Record<string, unknown>,
      };
    }
    case "threshold": {
      // thr:<key>:v<version>
      const m = /^thr:([^:]+):v(\d+)$/.exec(id);
      if (!m) return fail(type, id, "Malformed threshold id.");
      const row = db
        .prepare(`SELECT * FROM threshold_setting WHERE facility_id = ? AND key = ? AND version = ?`)
        .get(facilityId, m[1], Number(m[2])) as Record<string, unknown> | undefined;
      if (!row) return fail(type, id, "Threshold setting not found in this facility.");
      return {
        ok: true, type, id,
        title: `${row.key} = ${row.value} (v${row.version})`,
        detail: `Facility threshold, set by ${row.set_by}.`,
        link: `/docs/methodology`,
        record: row,
      };
    }
    case "methodology": {
      const key = id.replace(/^method:/, "");
      const def = METRICS[key];
      if (!def) return fail(type, id, "Unknown metric_type in methodology reference.");
      return {
        ok: true, type, id,
        title: `${def.label} — method v${def.methodVersion}`,
        detail: `${def.description} Unit: ${def.unit || "ratio"}. Plausible range ${def.sanity.min}–${def.sanity.max}. Status: ${def.status}.`,
        link: `/docs/methodology`,
        record: def as unknown as Record<string, unknown>,
      };
    }
    case "note": {
      const rowId = id.replace(/^note:/, "");
      const row = db
        .prepare(`SELECT * FROM clinical_assessment WHERE facility_id = ? AND athlete_id = ? AND id = ?`)
        .get(facilityId, athleteId, rowId) as Record<string, unknown> | undefined;
      if (!row) return fail(type, id, "Practitioner note not found for this athlete.");
      return {
        ok: true, type, id,
        title: `Practitioner note · ${row.assessed_on} (${row.category})`,
        detail: String(row.summary),
        link: `/athletes/${athleteId}`,
        record: row,
      };
    }
    case "training_session": {
      // derived window aggregate emitted by getTrainingContext
      const win = /^quality:training:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(id);
      if (win) {
        const agg = db
          .prepare(
            `SELECT COUNT(*) as c, ROUND(SUM(load_au)) as total FROM training_session
             WHERE facility_id = ? AND athlete_id = ? AND session_date >= ? AND session_date <= ?`
          )
          .get(facilityId, athleteId, win[1], win[2]) as { c: number; total: number | null };
        return {
          ok: true, type, id,
          title: `Training-load window ${win[1]} → ${win[2]}`,
          detail: `${agg.c} logged training session(s), total load ${agg.total ?? 0} AU (session RPE × duration), aggregated by the deterministic engine.`,
          link: `/athletes/${athleteId}/progress`,
          record: agg as unknown as Record<string, unknown>,
        };
      }
      const rowId = id.replace(/^train:/, "");
      const row = db
        .prepare(`SELECT * FROM training_session WHERE facility_id = ? AND athlete_id = ? AND id = ?`)
        .get(facilityId, athleteId, rowId) as Record<string, unknown> | undefined;
      if (!row) return fail(type, id, "Training session not found for this athlete.");
      return {
        ok: true, type, id,
        title: `Training ${row.session_date} · ${row.session_type}`,
        detail: `Duration ${row.duration_min} min, RPE ${row.rpe}, load ${row.load_au} AU.`,
        link: `/athletes/${athleteId}`,
        record: row,
      };
    }
    case "monitoring_result": {
      const rowId = id.replace(/^monres:/, "");
      const row = db
        .prepare(`SELECT * FROM monitoring_result WHERE facility_id = ? AND athlete_id = ? AND id = ?`)
        .get(facilityId, athleteId, rowId) as Record<string, unknown> | undefined;
      if (!row) return fail(type, id, "Monitoring result not found for this athlete in this facility.");
      return {
        ok: true, type, id,
        title: `Monitoring · ${row.metric_key} · ${row.session_date} — ${String(row.monitoring_state).replace(/_/g, " ")}`,
        detail: `Value ${row.current_value}; expected range ${row.band_low ?? "—"}–${row.band_high ?? "—"} (previous ${row.reference_count} sessions). Policy ${row.policy_fingerprint}, calc v${row.calc_version}.`,
        link: `/athletes/${athleteId}/monitoring`,
        record: row,
      };
    }
    case "alert": {
      const rowId = id.replace(/^alert:/, "");
      const row = db
        .prepare(`SELECT * FROM alert WHERE facility_id = ? AND athlete_id = ? AND id = ?`)
        .get(facilityId, athleteId, rowId) as Record<string, unknown> | undefined;
      if (!row) return fail(type, id, "Alert not found for this athlete in this facility.");
      return {
        ok: true, type, id,
        title: `Alert · ${String(row.alert_type).replace(/_/g, " ")} · ${row.session_date ?? String(row.created_at).slice(0, 10)}`,
        detail: `Status ${row.status}; severity ${row.severity}. Policy ${row.policy_fingerprint ?? "—"}.`,
        link: `/monitoring`,
        record: row,
      };
    }
    case "cohort": {
      // cohort:<team|position>:<name>:<metricKey>
      if (!/^cohort:(team|position):/.test(id)) return fail(type, id, "Malformed cohort-evidence id.");
      const metricKey = id.split(":").pop() ?? "";
      return {
        ok: true, type, id,
        title: `${id.split(":")[1] === "team" ? "Team" : "Position"} cohort — ${METRICS[metricKey]?.shortLabel ?? metricKey}`,
        detail:
          "Cohort statistics from the deterministic team-analytics service (population SD, athlete included in own cohort; no z-score when n<2 or variance is zero). Same values as the roster team-analytics view.",
        link: `/`,
      };
    }
    case "curve": {
      // curve:<testType>:<tokenA[..vs..tokenB]>
      if (!/^curve:(cmj|imtp):/.test(id)) return fail(type, id, "Malformed curve-evidence id.");
      return {
        ok: true, type, id,
        title: id.includes("..vs..") ? "Force-time curve comparison" : "Prepared force-time curve",
        detail:
          "Prepared by the deterministic curve workspace (onset-aligned, validated attempts only). Official values come from persisted metric rows and full-rate-derived event markers; display-resolution values are labeled as such.",
        link: `/athletes/${athleteId}`,
      };
    }
    case "lv_profile": {
      // lv:<exercise>:<date>
      if (!/^lv:/.test(id)) return fail(type, id, "Malformed load-velocity evidence id.");
      return {
        ok: true, type, id,
        title: `Load–velocity profile — ${id.split(":")[1]?.replace(/_/g, " ") ?? "exercise"}`,
        detail:
          "Rebuilt live from stored valid reps (mean of valid reps per distinct load; two-point method at 2 loads, least squares at 3+; R² only with ≥3 loads; no 1RM prediction).",
        link: `/athletes/${athleteId}`,
      };
    }
    // Derived/computed evidence: self-describing ids validated by shape.
    case "metric_series":
    case "baseline":
    case "comparability":
    case "quality": {
      const known =
        /^(series|baseline|cmp|quality):/.test(id);
      if (!known) return fail(type, id, "Malformed derived-evidence id.");
      const metricKey = id.split(":")[1];
      const metricName = METRICS[metricKey]?.shortLabel;
      return {
        ok: true, type, id,
        title:
          type === "metric_series"
            ? `${metricName ?? "Metric"} session-best series`
            : type === "baseline"
              ? `${metricName ?? "Metric"} baseline (${id.endsWith(":recent") ? "recent rolling band" : "reference benchmark"})`
              : type === "comparability"
                ? `Comparability check — ${metricName ?? metricKey}`
                : "Data completeness snapshot",
        detail:
          type === "metric_series"
            ? "Session-best series window computed by the deterministic engine (see the athlete's trend chart)."
            : type === "baseline"
              ? "Baseline computation (reference benchmark or recent rolling band) from the deterministic monitoring engine."
              : type === "comparability"
                ? "Comparability-gate result for a comparison window (test type, device, units, method version, quality, aggregation)."
                : "Data completeness / quality snapshot computed from session, trial, and metric records.",
        link: `/athletes/${athleteId}`,
      };
    }
    default:
      return fail(type, id, "Unknown evidence type.");
  }
}
