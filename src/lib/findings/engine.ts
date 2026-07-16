/**
 * Findings engine — deterministic, rule-based, versioned. No ML, no LLM.
 *
 * Regeneration is idempotent: all findings for an athlete are deleted and
 * rebuilt from current DB state, so findings always agree with the data
 * (dashboard and report read the same rows).
 *
 * Category boundaries (by design, non-overlapping):
 * - asymmetry_flag: general-athlete monitoring vs facility thresholds. NOT
 *   generated for athletes with an active RTS protocol.
 * - rts_stage_status: staged-criteria matching for a recovering athlete,
 *   evidence per criterion, never a verdict. Only for active protocols.
 * - training_context_note: ANNOTATES a baseline_deviation (refs.annotates);
 *   it never suppresses or downgrades one.
 * - data_gap: emitted where confidence would otherwise be pretended.
 */

import { getDb, newId, nowIso } from "../db/db";
import {
  getActiveProtocol,
  getAthlete,
  getThreshold,
  listInjuries,
  listStages,
  listTrainingSessions,
  sessionBestSeries,
} from "../db/dal";
import {
  ASYMMETRY_SOURCE_METRICS,
  BASELINE_MONITORED_METRICS,
  metricDef,
} from "../config/metrics";
import { monitorBaseline, BASELINE_METHOD_VERSION, DEFAULT_BASELINE_CONFIG } from "../calc/baseline";
import { limbSymmetryIndex, ASYM_METHOD_VERSION } from "../calc/asymmetry";
import { mean } from "../calc/signal";

export const FINDINGS_ENGINE_VERSION = "1.0.0";

export type FindingCategory =
  | "baseline_deviation"
  | "rts_stage_status"
  | "asymmetry_flag"
  | "training_context_note"
  | "data_gap";

export interface FindingRefs {
  metricType?: string;
  metricIds?: string[];
  sessionIds?: string[];
  methodVersion?: string;
  thresholdKey?: string;
  thresholdVersion?: number;
  thresholdValue?: number;
  protocolId?: string;
  protocolVersion?: number;
  stageId?: string;
  /** id of the finding this note annotates (training_context_note only) */
  annotates?: string;
  /** structured criterion evidence for rts_stage_status */
  criteria?: {
    id: string;
    label: string;
    met: boolean | null; // null = insufficient data (computed criteria) or n/a (context criteria)
    observed: string;
    target: string;
    /** "context" = practitioner-attested, not evaluated from platform metric data.
     *  Undefined/omitted = a normal computed criterion. */
    kind?: "context";
  }[];
  baseline?: { mean: number; sd: number; window: number };
}

interface NewFinding {
  category: FindingCategory;
  severity: "info" | "watch" | "flag";
  headline: string;
  detail: string;
  refs: FindingRefs;
  sessionDate?: string;
}

function insertFinding(facilityId: string, athleteId: string, f: NewFinding): string {
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO finding (id, facility_id, athlete_id, category, severity, headline, detail, refs_json, session_date, generated_at, engine_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      facilityId,
      athleteId,
      f.category,
      f.severity,
      f.headline,
      f.detail,
      JSON.stringify(f.refs),
      f.sessionDate ?? null,
      nowIso(),
      FINDINGS_ENGINE_VERSION
    );
  return id;
}

const fmt = (v: number, precision: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: precision, minimumFractionDigits: precision });

/* ------------------------------------------------------------------ */
/* baseline_deviation (+ training_context_note annotations)            */
/* ------------------------------------------------------------------ */

function baselineDeviationFindings(facilityId: string, athleteId: string): number {
  let count = 0;
  for (const metricType of BASELINE_MONITORED_METRICS) {
    const def = metricDef(metricType);
    const series = sessionBestSeries(facilityId, athleteId, metricType);
    if (series.length === 0) continue;

    const result = monitorBaseline(series, def.higherIsBetter, DEFAULT_BASELINE_CONFIG);

    if (!result.sufficientBaseline) {
      if (series.length >= 3) {
        // enough to be testing, not enough to monitor — say so instead of guessing
        count++;
        insertFinding(facilityId, athleteId, {
          category: "data_gap",
          severity: "info",
          headline: `${def.shortLabel}: baseline not yet established`,
          detail: `${series.length} of ${DEFAULT_BASELINE_CONFIG.minBenchmarkSessions} benchmark sessions recorded for ${def.label}. Deviation monitoring starts once the benchmark window is complete; no deviation conclusions are drawn before then.`,
          refs: {
            metricType,
            methodVersion: BASELINE_METHOD_VERSION,
            sessionIds: series.map((s) => s.sessionId),
          },
          sessionDate: series[series.length - 1].date,
        });
      }
      continue;
    }

    // findings for flagged sessions (most recent occurrence of each escalation run)
    for (const p of result.points) {
      if (p.flag === "none") continue;
      const sevMap = { below_band: "info", mandatory_deload: "watch", elevated_attention: "flag" } as const;
      const labelMap = {
        below_band: `single session below normal band — review / autoregulate volume (not intensity)`,
        mandatory_deload: `2 consecutive sessions below normal band — deload recommendation per monitoring rule`,
        elevated_attention: `${p.consecutiveBelow} consecutive sessions below normal band — elevated attention / review flag`,
      } as const;
      const findingId = insertFinding(facilityId, athleteId, {
        category: "baseline_deviation",
        severity: sevMap[p.flag],
        headline: `${def.shortLabel} ${labelMap[p.flag].split(" — ")[0]}`,
        detail: `${def.shortLabel} of ${fmt(p.value, def.precision)} ${def.unit} on ${p.date} is below the rolling normal band (${fmt(p.bandLow!, def.precision)}–${fmt(p.bandHigh!, def.precision)} ${def.unit}; rolling mean ${fmt(p.rollingMean!, def.precision)}). Rule outcome: ${labelMap[p.flag].split(" — ")[1]}. This is a measured-performance flag, not a risk score.`,
        refs: {
          metricType,
          methodVersion: BASELINE_METHOD_VERSION,
          sessionIds: [p.sessionId],
          baseline: {
            mean: result.baselineMean!,
            sd: result.baselineSd!,
            window: DEFAULT_BASELINE_CONFIG.rollingWindow,
          },
        },
        sessionDate: p.date,
      });
      count++;

      // training context annotation: high acute load in the 72 h before the flagged session
      count += maybeTrainingContextNote(facilityId, athleteId, findingId, p.date, def.shortLabel);
    }
  }
  return count;
}

function maybeTrainingContextNote(
  facilityId: string,
  athleteId: string,
  annotatesFindingId: string,
  sessionDate: string,
  metricLabel: string
): number {
  const to = sessionDate;
  const fromDate = new Date(sessionDate + "T00:00:00Z");
  fromDate.setUTCDate(fromDate.getUTCDate() - 3);
  const from = fromDate.toISOString().slice(0, 10);
  const sessions = listTrainingSessions(facilityId, athleteId, { from, to });
  const acute = sessions.reduce((a, s) => a + (s.load_au ?? 0), 0);

  // chronic reference: mean 3-day load over the prior 4 weeks
  const chronicFrom = new Date(sessionDate + "T00:00:00Z");
  chronicFrom.setUTCDate(chronicFrom.getUTCDate() - 28);
  const chronicSessions = listTrainingSessions(facilityId, athleteId, {
    from: chronicFrom.toISOString().slice(0, 10),
    to,
  });
  const chronicTotal = chronicSessions.reduce((a, s) => a + (s.load_au ?? 0), 0);
  const chronic3d = chronicTotal > 0 ? (chronicTotal / 28) * 3 : 0;

  if (chronic3d > 0 && acute > 1.5 * chronic3d) {
    insertFinding(facilityId, athleteId, {
      category: "training_context_note",
      severity: "info",
      headline: `High training load preceded the ${metricLabel} deviation`,
      detail: `Training load in the 72 h before ${sessionDate} totaled ${Math.round(acute)} AU vs a ~${Math.round(chronic3d)} AU 3-day norm over the prior 4 weeks. Context only: this note annotates the deviation finding and does not downgrade or dismiss it.`,
      refs: { annotates: annotatesFindingId, sessionIds: sessions.map((s) => s.id) },
      sessionDate,
    });
    return 1;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* asymmetry_flag (general athletes only — not RTS)                    */
/* ------------------------------------------------------------------ */

function asymmetryFindings(facilityId: string, athleteId: string): number {
  let count = 0;
  const watch = getThreshold(facilityId, "asymmetry_watch_pct");
  const flag = getThreshold(facilityId, "asymmetry_flag_pct");
  const watchPct = watch?.value ?? 10;
  const flagPct = flag?.value ?? 15;

  for (const sourceMetric of ASYMMETRY_SOURCE_METRICS) {
    const def = metricDef(sourceMetric);
    const series = getDb()
      .prepare(
        `SELECT m.id, m.value, s.session_date as date, m.session_id
         FROM metric m JOIN session s ON s.id = m.session_id
         WHERE m.facility_id = ? AND m.athlete_id = ? AND m.metric_type = 'asymmetry_index' AND m.method_version = ?
         ORDER BY s.session_date ASC`
      )
      .all(facilityId, athleteId, `${ASYM_METHOD_VERSION}:${sourceMetric}`) as {
      id: string;
      value: number;
      date: string;
      session_id: string;
    }[];
    if (series.length === 0) continue;

    const latest = series[series.length - 1];
    if (latest.value >= watchPct) {
      const severity = latest.value >= flagPct ? "flag" : "watch";
      const recent = series.slice(-4);
      const recentMean = mean(recent.map((r) => r.value));
      const persistent = recent.length >= 3 && recent.every((r) => r.value >= watchPct);
      insertFinding(facilityId, athleteId, {
        category: "asymmetry_flag",
        severity,
        headline: `${def.shortLabel} asymmetry at ${fmt(latest.value, 1)}%`,
        detail: `Latest ${def.label} asymmetry index is ${fmt(latest.value, 1)}% (facility ${severity} threshold: ${severity === "flag" ? flagPct : watchPct}%). ${
          persistent
            ? `It has stayed at or above ${watchPct}% across the last ${recent.length} test sessions (mean ${fmt(recentMean, 1)}%).`
            : `Recent ${recent.length}-session mean is ${fmt(recentMean, 1)}%.`
        } Formula: |stronger − weaker| ÷ mean of sides × 100.`,
        refs: {
          metricType: sourceMetric,
          metricIds: [latest.id],
          sessionIds: [latest.session_id],
          methodVersion: ASYM_METHOD_VERSION,
          thresholdKey: severity === "flag" ? "asymmetry_flag_pct" : "asymmetry_watch_pct",
          thresholdVersion: (severity === "flag" ? flag : watch)?.version ?? 1,
          thresholdValue: severity === "flag" ? flagPct : watchPct,
        },
        sessionDate: latest.date,
      });
      count++;
    }
  }

  // data gap: sided source metrics missing entirely (e.g. single-plate data)
  const anySided = getDb()
    .prepare(
      `SELECT COUNT(*) as c FROM metric WHERE facility_id = ? AND athlete_id = ? AND side IN ('left','right')`
    )
    .get(facilityId, athleteId) as { c: number };
  const anyMetrics = getDb()
    .prepare(`SELECT COUNT(*) as c FROM metric WHERE facility_id = ? AND athlete_id = ?`)
    .get(facilityId, athleteId) as { c: number };
  if (anyMetrics.c > 0 && anySided.c === 0) {
    insertFinding(facilityId, athleteId, {
      category: "data_gap",
      severity: "info",
      headline: "No per-side data — asymmetry not assessable",
      detail:
        "This athlete's tests contain no left/right force data (single-plate or metric-only imports). Asymmetry monitoring is inactive rather than estimated.",
      refs: {},
    });
    count++;
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* rts_stage_status (recovering athletes with an active protocol)      */
/* ------------------------------------------------------------------ */

interface StageCriterion {
  id: string;
  label: string;
  /** required for computed kinds; unused for "context" */
  metric_type?: string;
  /** "context" = practitioner-attested item (e.g. ROM, pain/swelling, a test the
   *  platform does not compute) — never evaluated against metric data, always
   *  shown as documented separately, never merged into the met/total count. */
  kind: "lsi" | "absolute" | "baseline_pct" | "context";
  operator?: ">=" | "<=";
  target?: number;
  unit?: string;
  /** context kind only: what the evidence table shows under "Observed" */
  note?: string;
}

function rtsFindings(facilityId: string, athleteId: string): number {
  const protocol = getActiveProtocol(facilityId, athleteId);
  if (!protocol) return 0;
  const stages = listStages(facilityId, protocol.id);
  const current = stages.find((s) => s.status === "current");
  if (!current) return 0;

  const injuries = listInjuries(facilityId, athleteId);
  const activeInjury = injuries.find((i) => !i.resolved_on);
  const involvedSide = (activeInjury?.involved_side ?? null) as "left" | "right" | null;

  const criteria = JSON.parse(current.criteria_json) as StageCriterion[];
  const evidence: NonNullable<FindingRefs["criteria"]> = [];
  const metricIds: string[] = [];
  let latestDate: string | undefined;

  for (const c of criteria) {
    if (c.kind === "context") {
      // Practitioner-attested item (e.g. ROM, pain/swelling, a test this
      // platform doesn't compute). Never evaluated from metric data, and
      // excluded from the met/total count below — it is documented
      // separately, not "insufficient data" (which implies the platform
      // tried to compute it).
      evidence.push({
        id: c.id,
        label: c.label,
        met: null,
        observed: c.note ?? "Documented by the athlete's performance team; not evaluated by this platform.",
        target: "n/a — practitioner-attested",
        kind: "context",
      });
      continue;
    }
    // Every non-"context" kind is defined with metric_type/operator/target/unit
    // by construction (only "context" criteria omit them, and that branch
    // already continued above), so these are safe to assert non-null here.
    const metricType = c.metric_type!;
    const operator = c.operator!;
    const target = c.target!;
    const unit = c.unit ?? "";
    const def = metricDef(metricType);
    if (c.kind === "lsi") {
      if (!involvedSide) {
        evidence.push({
          id: c.id, label: c.label, met: null,
          observed: "involved side not recorded on the training-interruption record",
          target: `${operator} ${target}${unit}`,
        });
        continue;
      }
      const sideVal = (side: string) => {
        const row = getDb()
          .prepare(
            `SELECT m.id, MAX(m.value) as v, s.session_date as date FROM metric m
             JOIN session s ON s.id = m.session_id
             WHERE m.facility_id = ? AND m.athlete_id = ? AND m.metric_type = ? AND m.side = ?
             GROUP BY m.session_id ORDER BY s.session_date DESC LIMIT 1`
          )
          .get(facilityId, athleteId, metricType, side) as
          | { id: string; v: number; date: string }
          | undefined;
        return row;
      };
      const inv = sideVal(involvedSide);
      const uninv = sideVal(involvedSide === "left" ? "right" : "left");
      if (!inv || !uninv) {
        evidence.push({
          id: c.id, label: c.label, met: null,
          observed: "no recent per-side data for this metric",
          target: `${operator} ${target}${unit}`,
        });
        continue;
      }
      const lsi = limbSymmetryIndex(inv.v, uninv.v, involvedSide);
      const met = operator === ">=" ? lsi.lsiPct >= target : lsi.lsiPct <= target;
      evidence.push({
        id: c.id, label: c.label, met,
        observed: `LSI ${fmt(lsi.lsiPct, 1)}% (${involvedSide} ${fmt(inv.v, def.precision)} / ${involvedSide === "left" ? "right" : "left"} ${fmt(uninv.v, def.precision)} ${def.unit}, ${inv.date})`,
        target: `${operator} ${target}${unit}`,
      });
      metricIds.push(inv.id);
      latestDate = latestDate && latestDate > inv.date ? latestDate : inv.date;
    } else if (c.kind === "absolute" || c.kind === "baseline_pct") {
      const series = sessionBestSeries(facilityId, athleteId, metricType);
      if (series.length === 0) {
        evidence.push({
          id: c.id, label: c.label, met: null,
          observed: "no data recorded for this metric",
          target: `${operator} ${target}${unit}`,
        });
        continue;
      }
      const latest = series[series.length - 1];
      let observedVal = latest.value;
      let targetDesc = `${operator} ${target}${unit}`;
      let met: boolean;
      if (c.kind === "baseline_pct") {
        // baseline = mean of sessions before the injury date
        const injuryDate = activeInjury?.occurred_on ?? "9999-12-31";
        const pre = series.filter((s) => s.date < injuryDate);
        if (pre.length < 3) {
          evidence.push({
            id: c.id, label: c.label, met: null,
            observed: `only ${pre.length} pre-interruption sessions — reference baseline not computable`,
            target: `${operator} ${target}% of reference baseline`,
          });
          continue;
        }
        const baseMean = mean(pre.map((s) => s.value));
        observedVal = (latest.value / baseMean) * 100;
        targetDesc = `${operator} ${target}% of reference baseline (${fmt(baseMean, def.precision)} ${def.unit}, n=${pre.length})`;
        met = operator === ">=" ? observedVal >= target : observedVal <= target;
        evidence.push({
          id: c.id, label: c.label, met,
          observed: `${fmt(observedVal, 1)}% of baseline (${fmt(latest.value, def.precision)} ${def.unit} on ${latest.date})`,
          target: targetDesc,
        });
      } else {
        met = operator === ">=" ? observedVal >= target : observedVal <= target;
        evidence.push({
          id: c.id, label: c.label, met,
          observed: `${fmt(observedVal, def.precision)} ${def.unit} (${latest.date})`,
          target: targetDesc,
        });
      }
      latestDate = latestDate && latestDate > latest.date ? latestDate : latest.date;
    }
  }

  // Context (practitioner-attested) items are evidence, but they're never
  // computed by this platform, so they're kept out of the "X of Y met"
  // count — that count means "computed criteria met," not "all boxes checked."
  const computedEvidence = evidence.filter((e) => e.kind !== "context");
  const contextCount = evidence.length - computedEvidence.length;
  const metCount = computedEvidence.filter((e) => e.met === true).length;
  const pendingData = computedEvidence.filter((e) => e.met === null).length;
  const total = computedEvidence.length;

  insertFinding(facilityId, athleteId, {
    category: "rts_stage_status",
    severity: "info",
    headline: `Stage ${current.stage_number} (“${current.name}”): ${metCount} of ${total} practitioner-defined criteria currently met${contextCount > 0 ? ` (+${contextCount} item${contextCount === 1 ? "" : "s"} documented by the athlete's performance team, tracked separately)` : ""}`,
    detail: `ILLUSTRATIVE DEMO PROTOCOL — this stage/criteria set is placeholder content built to demonstrate the platform's capability, not any real athlete's actual progression plan. Criteria status for ${protocol.name} (v${protocol.version}), defined by ${protocol.defined_by}. This is measured evidence against practitioner-set targets — progression decisions remain with the athlete's qualified performance and support team.${
      pendingData > 0 ? ` ${pendingData} criteri${pendingData === 1 ? "on" : "a"} lack sufficient data and are shown as “insufficient data”, not as met.` : ""
    }${
      contextCount > 0 ? ` ${contextCount} additional criteri${contextCount === 1 ? "on is" : "a are"} practitioner-attested (e.g. range of motion, movement comfort, tests this platform does not compute) and ${contextCount === 1 ? "is" : "are"} shown as documented separately, not evaluated here.` : ""
    }`,
    refs: {
      protocolId: protocol.id,
      protocolVersion: protocol.version,
      stageId: current.id,
      criteria: evidence,
      metricIds,
    },
    sessionDate: latestDate,
  });
  return 1;
}

/* ------------------------------------------------------------------ */
/* data_gap: testing recency                                           */
/* ------------------------------------------------------------------ */

function recencyFindings(facilityId: string, athleteId: string, today: string): number {
  const last = getDb()
    .prepare(
      `SELECT MAX(session_date) as d FROM session WHERE facility_id = ? AND athlete_id = ?`
    )
    .get(facilityId, athleteId) as { d: string | null };
  if (!last.d) {
    insertFinding(facilityId, athleteId, {
      category: "data_gap",
      severity: "info",
      headline: "No test sessions recorded",
      detail: "This athlete has no force-plate or performance test data yet. Nothing is inferred in the absence of data.",
      refs: {},
    });
    return 1;
  }
  const days = Math.floor(
    (new Date(today + "T00:00:00Z").getTime() - new Date(last.d + "T00:00:00Z").getTime()) / 86400000
  );
  if (days > 14) {
    insertFinding(facilityId, athleteId, {
      category: "data_gap",
      severity: "watch",
      headline: `No testing in ${days} days`,
      detail: `Last recorded test session was ${last.d}. Monitoring statements lose currency after 14 days without data; trends shown are historical until a new session is recorded.`,
      refs: {},
      sessionDate: last.d,
    });
    return 1;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

export function regenerateFindings(facilityId: string, athleteId: string, today?: string): number {
  const db = getDb();
  const athlete = getAthlete(facilityId, athleteId);
  if (!athlete) return 0; // facility scope: never generate across facilities

  db.prepare(`DELETE FROM finding WHERE facility_id = ? AND athlete_id = ?`).run(facilityId, athleteId);

  const refDate =
    today ??
    ((db
      .prepare(`SELECT MAX(session_date) as d FROM session WHERE facility_id = ?`)
      .get(facilityId) as { d: string | null }).d ??
      new Date().toISOString().slice(0, 10));

  let count = 0;
  count += baselineDeviationFindings(facilityId, athleteId);
  const hasActiveProtocol = !!getActiveProtocol(facilityId, athleteId);
  if (hasActiveProtocol) {
    count += rtsFindings(facilityId, athleteId);
  } else {
    count += asymmetryFindings(facilityId, athleteId);
  }
  count += recencyFindings(facilityId, athleteId, refDate);
  return count;
}
