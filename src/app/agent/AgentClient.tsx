"use client";

/**
 * Athlete intelligence — trainer-facing product surface.
 *
 * Presentation layer only: renders the validated AgentRun structures.
 * Run + review persistence lives HERE (localStorage), not in the server
 * process: route handlers return complete run snapshots and stay stateless.
 * The original generated report is never mutated — reviewer edits create a
 * ReviewRecord carrying the revised text alongside the preserved original.
 *
 * Product structure:
 *   Briefing  — key numbers, status, findings (primary value)
 *   Ask       — the seven focused questions
 *   Timeline  — checkpoints, what changed, decisions
 *   Review    — a focused action (side sheet), not a destination
 *   Developer — a SEPARATE full-screen audit view; the trainer product
 *               renders no IDs, traces, schema terms, or raw payloads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AgentRun,
  Claim,
  EvidenceRef,
  QUESTION_KEYS,
  QUESTION_LABELS,
  QuestionKey,
  ReviewAction,
  ReviewRecord,
} from "@/lib/agent/schemas";
import { diffReports } from "@/lib/agent/diff";
import { METRICS } from "@/lib/config/metrics";

interface Props {
  facility: { id: string; name: string };
  athletes: { id: string; name: string; team: string }[];
  athlete: { id: string; name: string; sport: string; hasPlan: boolean };
  lastTestDate: string | null;
  checkpoints: { date: string; label: string }[];
  initialRun: AgentRun;
  configuredMode: string;
  initialQuestionKey?: string;
  initialFindingId?: string;
}

interface ResolvedEvidence {
  ok: boolean;
  title: string;
  detail: string;
  link?: string;
  error?: string;
}

type View = "briefing" | "ask" | "timeline";
type Bucket = "stable" | "monitor" | "gaps" | "context";

const VIEWS: { key: View; label: string }[] = [
  { key: "briefing", label: "Briefing" },
  { key: "ask", label: "Ask the data" },
  { key: "timeline", label: "Timeline" },
];

const runsKey = (f: string, a: string) => `tracelab:agent:runs:${f}:${a}`;
const reviewsKey = (f: string) => `tracelab:agent:reviews:${f}`;

const load = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full/blocked — demo persistence is best-effort */
  }
};

/* ---------- trainer-facing presentation of existing claim fields ---------- */

const metricLabel = (key?: string) => (key && METRICS[key] ? METRICS[key].shortLabel : undefined);

function claimHeadline(c: Claim): string {
  const m = metricLabel(c.metricKey);
  switch (c.claimType) {
    case "baseline_comparison": return `${m ?? "Output"} vs baseline`;
    case "trend": return `${m ?? "Metric"} trend`;
    case "asymmetry": return `${m ? `${m} asymmetry` : "Left–right asymmetry"}`;
    case "criteria_status": return "Progression criteria";
    case "strategy_shift": return "Output vs movement strategy";
    case "conflict": return "Signals disagree";
    case "agreement": return "Signals agree";
    case "data_quality": return "Data quality";
    case "data_gap": return "Missing data";
    case "context": return "Training & staff context";
    case "cohort_comparison": return `${m ?? "Metric"} vs team/position`;
    case "curve_comparison": return "Force-time curve comparison";
    case "load_velocity_profile": return "Load–velocity profile";
  }
}

/** Presentation grouping only — reads sign/status wording the engine already produced. */
function bucketOf(c: Claim, conflicted: boolean): Bucket {
  if (c.claimType === "data_gap" || c.claimType === "data_quality") return "gaps";
  if (c.claimType === "conflict") return "gaps";
  if (c.claimType === "context") return "context";
  if (c.claimType === "asymmetry" || c.claimType === "strategy_shift") return "monitor";
  if (conflicted) return "monitor";
  if (c.claimType === "trend" && /\(-|−\d/.test(c.text)) return "monitor";
  if (c.claimType === "baseline_comparison" && /below recent band/i.test(c.text)) return "monitor";
  if (c.claimType === "criteria_status" && /closest gap/i.test(c.text)) return "monitor";
  return "stable";
}

const BUCKET_ACCENT: Record<Bucket, string> = {
  stable: "var(--ok)",
  monitor: "var(--watch)",
  gaps: "var(--left)",
  context: "var(--line-strong)",
};

function prettyWindow(w?: string): string | null {
  if (!w) return null;
  if (/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(w)) return w.replace("..", " → ");
  const map: Record<string, string> = {
    "latest-vs-reference-and-recent": "Latest session vs reference & recent baselines",
    "recent-window": "Recent sessions",
    "current-stage": "Current plan stage",
    "outcome-vs-strategy": "Outcome vs strategy metrics",
    current: "Current signals",
    "current-findings": "Current findings",
    "finding-explanation": "Finding explanation",
  };
  if (map[w]) return map[w];
  if (/^\d+d$/.test(w)) return `Last ${w.slice(0, -1)} days`;
  return w.replace(/-/g, " ");
}

const shortDate = (iso?: string) => (iso ? iso.slice(0, 10) : "");
const shortStamp = (iso: string) => iso.slice(0, 16).replace("T", " ");
const shortTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const firstSentence = (t: string) => (t.match(/^.*?[.?!](?=\s|$)/) ?? [t])[0];

/** plain-language names for safety checks shown in the trainer product */
const CHECK_LABELS: Record<string, string> = {
  schema_validation: "Report structure",
  prohibited_language: "Blocked wording",
  overconfident_language: "Overconfident wording",
  evidence_presence: "A finding lacks evidence",
  evidence_validity: "Evidence couldn't be verified",
  numeric_fidelity: "A number doesn't match its evidence",
  comparability_enforced: "A comparison used non-comparable sessions",
  baseline_distinction: "Baseline wording is ambiguous",
  quality_disclosure: "Low data quality wasn't disclosed",
  no_verdict_aggregation: "Findings were merged into a verdict",
};

const REVIEW_TONE: Record<ReviewAction, string> = { approve: "ok", edit: "stage", needs_more_data: "watch", reject: "alert" };
const REVIEW_LABEL: Record<ReviewAction, string> = { approve: "Approved", edit: "Edited", needs_more_data: "Needs more data", reject: "Rejected" };

const REVIEW_ACTIONS: { action: ReviewAction; label: string; consequence: string }[] = [
  { action: "approve", label: "Approve", consequence: "Report is reviewed and usable, kept exactly as generated." },
  { action: "edit", label: "Edit interpretation", consequence: "Your revised summary is saved as a separate record; the original stays unchanged." },
  { action: "needs_more_data", label: "Needs more data", consequence: "Not actionable yet — testing or context is missing." },
  { action: "reject", label: "Reject", consequence: "Not usable. Kept in history for audit; nothing is deleted." },
];

/* ---------- key-number tiles from existing validated evidence ---------- */

interface Tile {
  label: string;
  value: string;
  context: string;
  tone: Bucket;
  delta?: number; // % change already computed by the engine
}

function statTiles(report: NonNullable<AgentRun["report"]>, conflictedIds: string[]): Tile[] {
  const tiles: Tile[] = [];
  const claims = report.claims;

  const bcl = claims.find((c) => c.claimType === "baseline_comparison");
  if (bcl) {
    const sess = bcl.evidenceRefs.find((r) => r.type === "session" && r.value != null);
    const pct = sess?.values?.[1];
    if (sess?.value != null) {
      tiles.push({
        label: metricLabel(bcl.metricKey) ?? "Output",
        value: `${sess.value}${sess.unit ? ` ${sess.unit}` : ""}`,
        context: pct != null ? `${pct}% of baseline` : "latest session",
        tone: bucketOf(bcl, conflictedIds.includes(bcl.claimId)),
      });
    }
  }

  const asym = claims.find((c) => c.claimType === "asymmetry");
  if (asym) {
    const series = asym.evidenceRefs.find((r) => r.type === "metric_series");
    const watch = asym.evidenceRefs.find((r) => r.type === "threshold");
    const latest = series?.values?.[0];
    if (latest != null) {
      tiles.push({
        label: "Asymmetry",
        value: `${latest}%`,
        context: watch?.value != null ? `watch level ${watch.value}%` : "left–right difference",
        tone: "monitor",
      });
    }
  }

  const crit = claims.find((c) => c.claimType === "criteria_status");
  if (crit) {
    const f = crit.evidenceRefs.find((r) => r.type === "finding" && (r.values?.length ?? 0) >= 2);
    if (f?.values) {
      tiles.push({
        label: "Criteria met",
        value: `${f.values[0]} of ${f.values[1]}`,
        context: "current plan stage",
        tone: bucketOf(crit, false),
      });
    }
  }

  const trend = claims.find((c) => c.claimType === "trend");
  if (trend) {
    const series = trend.evidenceRefs.find((r) => r.type === "metric_series");
    const v = series?.values;
    if (v && v.length >= 7 && v[1] != null) {
      tiles.push({
        label: metricLabel(trend.metricKey) ?? "Trend",
        value: `${v[1]}${series?.unit ? ` ${series.unit}` : ""}`,
        context: `${v[6]} sessions`,
        tone: bucketOf(trend, false),
        delta: v[5],
      });
    }
  }

  return tiles.slice(0, 4);
}

/* ------------------------------------------------------------------ */

export default function AgentClient(props: Props) {
  const router = useRouter();
  const { facility, athlete } = props;
  const [runs, setRuns] = useState<AgentRun[]>([props.initialRun]);
  const [reportId, setReportId] = useState(props.initialRun.runId);
  const [answerId, setAnswerId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [view, setView] = useState<View>("briefing");
  const [devMode, setDevMode] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
  const [explorer, setExplorer] = useState<{ ref: EvidenceRef; resolved: ResolvedEvidence | null } | null>(null);
  const [compareAgainst, setCompareAgainst] = useState<string>("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<ReviewAction | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [editText, setEditText] = useState("");
  const viewRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  /* hydrate persisted runs/reviews, then merge the fresh server run */
  useEffect(() => {
    const stored = load<AgentRun[]>(runsKey(facility.id, athlete.id), []);
    const merged = stored.some((r) => r.runId === props.initialRun.runId)
      ? stored
      : [...stored, props.initialRun].slice(-10);
    setRuns(merged);
    setReportId(props.initialRun.runId);
    save(runsKey(facility.id, athlete.id), merged);
    setReviews(load<ReviewRecord[]>(reviewsKey(facility.id), []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athlete.id, props.initialRun.runId]);

  const reportRuns = useMemo(
    () => runs.filter((r) => r.task === "report" && r.report).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [runs]
  );
  const answerRuns = useMemo(
    () => runs.filter((r) => r.task === "question" && r.answer).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [runs]
  );
  const reportRun = reportRuns.find((r) => r.runId === reportId) ?? reportRuns[reportRuns.length - 1];
  const answerRun = answerRuns.find((r) => r.runId === answerId) ?? null;
  const report = reportRun?.report;
  const reportReviews = reviews
    .filter((rv) => reportRun && rv.runId === reportRun.runId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const latestReview = reportReviews[reportReviews.length - 1];
  const athleteRunIds = useMemo(() => new Set(runs.map((r) => r.runId)), [runs]);
  const athleteReviews = useMemo(
    () => reviews.filter((rv) => athleteRunIds.has(rv.runId)).sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [reviews, athleteRunIds]
  );

  const persistRun = useCallback(
    (run: AgentRun) => {
      setRuns((prev) => {
        const next = [...prev.filter((r) => r.runId !== run.runId), run].slice(-10);
        save(runsKey(facility.id, athlete.id), next);
        return next;
      });
      if (run.task === "report") setReportId(run.runId);
      else setAnswerId(run.runId);
    },
    [facility.id, athlete.id]
  );

  const execute = useCallback(
    async (body: Record<string, unknown>, label: string) => {
      setBusy(label);
      setError(null);
      try {
        const res = await fetch("/api/agent/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ athleteId: athlete.id, ...body }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        persistRun(json as AgentRun);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [athlete.id, persistRun]
  );

  /* deep-link entry points (?ask=why_finding&finding=...) */
  useEffect(() => {
    if (props.initialQuestionKey && (QUESTION_KEYS as readonly string[]).includes(props.initialQuestionKey)) {
      setView("ask");
      void execute(
        { task: "question", questionKey: props.initialQuestionKey, findingId: props.initialFindingId },
        "question"
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* review sheet: esc to close, focus on open */
  useEffect(() => {
    if (!sheetOpen) return;
    sheetRef.current?.querySelector<HTMLElement>("button, input, textarea")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  const saveReview = (action: ReviewAction) => {
    if (!reportRun?.report) return;
    const revised = action === "edit" ? editText : undefined;
    const record: ReviewRecord = {
      reviewId: `rev_${Math.random().toString(36).slice(2, 10)}`,
      runId: reportRun.runId,
      originalReportId: reportRun.report.reportId,
      action,
      reviewer: "Coach (demo session)",
      reason: reviewNote || undefined,
      revisedExecutiveSummary: revised,
      revisedReportId: revised ? `${reportRun.report.reportId}-rev${reportReviews.length + 1}` : undefined,
      timestamp: new Date().toISOString(),
    };
    const next = [...reviews, record];
    setReviews(next);
    save(reviewsKey(facility.id), next);
    setPendingAction(null);
    setReviewNote("");
    setEditText("");
  };

  const openEvidenceDetail = async (ref: EvidenceRef) => {
    setExplorer({ ref, resolved: null });
    try {
      const res = await fetch(
        `/api/agent/evidence?type=${encodeURIComponent(ref.type)}&id=${encodeURIComponent(ref.id)}&athleteId=${athlete.id}`
      );
      setExplorer({ ref, resolved: (await res.json()) as ResolvedEvidence });
    } catch {
      setExplorer({ ref, resolved: { ok: false, title: "Lookup unavailable", detail: "Could not resolve this record right now." } });
    }
  };

  /* ---------- derived briefing structure ---------- */

  const grouped = useMemo(() => {
    const g: Record<Bucket, Claim[]> = { stable: [], monitor: [], gaps: [], context: [] };
    if (report) for (const c of report.claims) g[bucketOf(c, report.conflictingSignals.includes(c.claimId))].push(c);
    return g;
  }, [report]);

  const attention = useMemo(() => [...grouped.monitor, ...grouped.gaps], [grouped]);
  const priorities = attention.slice(0, 3);
  const secondary = attention.slice(3);
  const tiles = useMemo(() => (report ? statTiles(report, report.conflictingSignals) : []), [report]);

  const statusStatement = useMemo(() => {
    if (!report) return "";
    const bits: string[] = [];
    if (grouped.monitor.length) bits.push(`${grouped.monitor.length} signal${grouped.monitor.length > 1 ? "s" : ""} to monitor`);
    if (grouped.gaps.length) bits.push(`${grouped.gaps.length} data note${grouped.gaps.length > 1 ? "s" : ""}`);
    if (grouped.stable.length) bits.push(`${grouped.stable.length} steady or improving`);
    return bits.join(" · ") || "No findings from the current data.";
  }, [report, grouped]);

  const diff = useMemo(() => {
    if (!report || !compareAgainst) return null;
    const prev = reportRuns.find((r) => r.runId === compareAgainst)?.report;
    return prev && prev.reportId !== report.reportId ? diffReports(prev, report) : null;
  }, [report, compareAgainst, reportRuns]);

  useEffect(() => {
    if (view !== "timeline" || compareAgainst || reportRuns.length < 2 || !reportRun) return;
    const others = reportRuns.filter((r) => r.runId !== reportRun.runId);
    const preferred = others.filter((r) => !r.asOf).pop() ?? others[others.length - 1];
    if (preferred) setCompareAgainst(preferred.runId);
  }, [view, compareAgainst, reportRuns, reportRun]);

  const evalStatus = reportRun?.eval.status ?? "pass";
  const fellBack = !!reportRun?.provenance.fallback;
  const analysisPeriod = reportRun?.asOf ? `Data through ${reportRun.asOf}` : "Full history";

  /* ---------- render pieces ---------- */

  const SafetyNotice = ({ run }: { run: AgentRun }) =>
    run.eval.status === "pass" ? null : (
      <div className="ai-alert" data-level={run.eval.status}>
        <div className="ai-alert-title">
          {run.eval.status === "warn" ? "Check before using this report" : "Do not use this report"}
        </div>
        <p className="ai-alert-body">
          {run.eval.status === "warn"
            ? "Automatic safety checks flagged wording below — read the flagged items before acting on them."
            : "Automatic safety checks failed. The content is kept for audit only; refresh the analysis or check the items below."}
        </p>
        <ul className="ai-alert-list">
          {run.eval.checks.filter((c) => c.status !== "pass").map((c) => (
            <li key={c.name}>
              <strong>{CHECK_LABELS[c.name] ?? c.name.replace(/_/g, " ")}.</strong> {c.detail}
            </li>
          ))}
        </ul>
      </div>
    );

  const EvidenceBlock = ({ claim }: { claim: Claim }) => (
    <div className="evd-block">
      <div className="evd-block-intro">The records behind this — the same rows the dashboard shows.</div>
      {claim.evidenceRefs.map((evd) => {
        const active = explorer?.ref.id === evd.id;
        return (
          <div key={evd.id} className="evrow" data-active={active}>
            <div className="evrow-main">
              <div style={{ minWidth: 0 }}>
                <div className="evrow-title">{evd.label ?? "Evidence record"}</div>
                <div className="evrow-meta">
                  {[shortDate(evd.date), evd.value != null ? `observed ${evd.value}${evd.unit ?? ""}` : null].filter(Boolean).join(" · ") || " "}
                </div>
              </div>
              <button className="linklike" onClick={() => (active ? setExplorer(null) : void openEvidenceDetail(evd))}>
                {active ? "Hide" : "Details"}
              </button>
            </div>
            {active && (
              <div className="evrow-detail">
                {explorer?.resolved ? (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 13.5, color: explorer.resolved.ok ? "var(--ink)" : "var(--alert)" }}>{explorer.resolved.title}</div>
                    <div style={{ fontSize: 13, color: "var(--ink-dim)", marginTop: 2, lineHeight: 1.55 }}>{explorer.resolved.detail}</div>
                    {explorer.resolved.link && (
                      <a href={explorer.resolved.link} style={{ color: "var(--accent)", fontSize: 13, display: "inline-block", marginTop: 6 }}>Open in product →</a>
                    )}
                  </>
                ) : (
                  <div className="evrow-meta">Looking up…</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const FindingBlock = ({ claim, bucket, quiet }: { claim: Claim; bucket: Bucket; quiet?: boolean }) => {
    const windowText = prettyWindow(claim.comparisonWindow);
    const evidenceOpen = evidenceFor === claim.claimId;
    return (
      <article className={quiet ? "fb fb--quiet" : "fb"} style={{ borderLeftColor: BUCKET_ACCENT[bucket] }}>
        <div className="fb-head">
          <h3 className="fb-title">{claimHeadline(claim)}</h3>
          {claim.confidence === "low" && <span className="fb-flag">lower confidence</span>}
        </div>
        <p className="fb-text">{claim.text}</p>
        {claim.uncertaintyReason && <p className="fb-ctx">Caution: {claim.uncertaintyReason}</p>}
        <div className="fb-foot">
          {windowText && <span className="fb-ctx">{windowText}</span>}
          <button className="linklike" aria-expanded={evidenceOpen}
            onClick={() => { setEvidenceFor(evidenceOpen ? null : claim.claimId); setExplorer(null); }}>
            {evidenceOpen ? "Hide evidence" : "See evidence"}
          </button>
        </div>
        {evidenceOpen && <EvidenceBlock claim={claim} />}
      </article>
    );
  };

  const reviewPill = (
    <span className="ai-pill" data-tone={latestReview ? REVIEW_TONE[latestReview.action] : "pending"}>
      {latestReview ? REVIEW_LABEL[latestReview.action] : "Awaiting review"}
    </span>
  );

  /* ================= DEVELOPER / AUDIT VIEW (separate experience) ================= */

  if (devMode && reportRun) {
    return (
      <main className="page">
        <div className="dev-bar">
          <button className="btn secondary" onClick={() => setDevMode(false)}>← Back to product</button>
          <div>
            <div className="eyebrow">Developer & audit view</div>
            <h1 style={{ fontSize: 22 }}>{athlete.name} — run internals</h1>
          </div>
        </div>

        <div className="panel">
          <h3 style={{ fontSize: 14, marginBottom: 6 }}>Safety checks — report</h3>
          {reportRun.eval.checks.map((c) => (
            <div key={c.name} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 0", borderBottom: "1px solid var(--line)", fontSize: 12 }}>
              <span className="sev" data-sev={c.status === "pass" ? "ok" : c.status === "warn" ? "watch" : "flag"} style={{ minWidth: 180, fontFamily: "var(--font-mono)", fontSize: 11 }}>{c.name}</span>
              <span style={{ color: "var(--ink-dim)" }}>{c.detail}</span>
            </div>
          ))}
          {answerRun && (
            <>
              <h3 style={{ fontSize: 14, margin: "14px 0 6px" }}>Safety checks — latest answer</h3>
              {answerRun.eval.checks.map((c) => (
                <div key={c.name} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 0", borderBottom: "1px solid var(--line)", fontSize: 12 }}>
                  <span className="sev" data-sev={c.status === "pass" ? "ok" : c.status === "warn" ? "watch" : "flag"} style={{ minWidth: 180, fontFamily: "var(--font-mono)", fontSize: 11 }}>{c.name}</span>
                  <span style={{ color: "var(--ink-dim)" }}>{c.detail}</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="panel">
          <h3 style={{ fontSize: 14, marginBottom: 6 }}>Action & evidence trace (report run)</h3>
          <p className="panel-sub">Workflow stages, tool calls, validated inputs, result summaries, evidence ids, durations. No model chain-of-thought is captured or shown.</p>
          <div className="trace">
            {reportRun.trace.map((t) => (
              <div key={t.step} className="trace-step" data-status={t.status}>
                <div className="trace-dot" />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                    <span style={{ color: "var(--accent)" }}>{t.stage}</span>
                    {t.tool && <span style={{ color: "var(--ink)" }}> · {t.tool}</span>}
                    <span style={{ color: "var(--ink-mute)" }}> · {t.ms}ms · {t.status}</span>
                  </div>
                  {t.inputSummary !== "{}" && <div style={{ fontSize: 11, color: "var(--ink-mute)", fontFamily: "var(--font-mono)" }}>in: {t.inputSummary}</div>}
                  <div style={{ fontSize: 12, color: "var(--ink-dim)" }}>{t.resultSummary}</div>
                  {t.evidenceIds.length > 0 && (
                    <div style={{ fontSize: 10.5, color: "var(--ink-mute)", fontFamily: "var(--font-mono)" }}>
                      evidence: {t.evidenceIds.slice(0, 3).join(", ")}{t.evidenceIds.length > 3 ? ` +${t.evidenceIds.length - 3}` : ""}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h3 style={{ fontSize: 14, marginBottom: 6 }}>Run details</h3>
          <table className="data" style={{ fontSize: 11.5 }}>
            <tbody>
              <tr><td>run</td><td style={{ fontFamily: "var(--font-mono)" }}>{reportRun.provenance.runId}</td></tr>
              <tr><td>mode / provider / model</td><td style={{ fontFamily: "var(--font-mono)" }}>{reportRun.provenance.mode} / {reportRun.provenance.provider} / {reportRun.provenance.model}</td></tr>
              <tr><td>configured mode</td><td style={{ fontFamily: "var(--font-mono)" }}>{props.configuredMode}</td></tr>
              <tr><td>prompt / tool schema</td><td style={{ fontFamily: "var(--font-mono)" }}>v{reportRun.provenance.promptVersion} / v{reportRun.provenance.toolSchemaVersion}</td></tr>
              <tr><td>input snapshot hash</td><td style={{ fontFamily: "var(--font-mono)" }}>{reportRun.provenance.inputSnapshotHash}</td></tr>
              <tr><td>method versions</td><td style={{ fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{Object.entries(reportRun.provenance.methodVersions).map(([k, v]) => `${k}@${v}`).join(", ")}</td></tr>
              <tr><td>threshold versions</td><td style={{ fontFamily: "var(--font-mono)" }}>{reportRun.provenance.thresholdVersions.map((t) => `${t.key}=${t.value} (v${t.version})`).join(", ") || "—"}</td></tr>
              <tr><td>tool calls / latency</td><td style={{ fontFamily: "var(--font-mono)" }}>{reportRun.provenance.toolCallCount} calls · {reportRun.provenance.latencyMs}ms</td></tr>
              {reportRun.provenance.usage && <tr><td>tokens</td><td style={{ fontFamily: "var(--font-mono)" }}>{reportRun.provenance.usage.inputTokens} in / {reportRun.provenance.usage.outputTokens} out</td></tr>}
              {reportRun.provenance.fallback && <tr><td>fallback</td><td style={{ color: "var(--watch)" }}>from {reportRun.provenance.fallback.from}: {reportRun.provenance.fallback.reason.slice(0, 140)}</td></tr>}
            </tbody>
          </table>
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11.5, color: "var(--ink-mute)", marginBottom: 4 }}>Claim identities (deterministic — stable across wording changes):</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-mute)", overflowWrap: "anywhere" }}>
              {report?.claims.map((c) => `${c.claimType}:${c.claimId}`).join(" · ")}
            </div>
          </div>
        </div>

        <div className="panel">
          <h3 style={{ fontSize: 14, marginBottom: 6 }}>Raw report JSON</h3>
          <pre style={{ fontSize: 10, background: "var(--bg0)", border: "1px solid var(--line)", borderRadius: 6, padding: 10, overflow: "auto", maxHeight: 340 }}>
            {JSON.stringify(reportRun, null, 2)}
          </pre>
          {answerRun && (
            <>
              <h3 style={{ fontSize: 14, margin: "12px 0 6px" }}>Raw answer JSON (latest question)</h3>
              <pre style={{ fontSize: 10, background: "var(--bg0)", border: "1px solid var(--line)", borderRadius: 6, padding: 10, overflow: "auto", maxHeight: 340 }}>
                {JSON.stringify(answerRun, null, 2)}
              </pre>
            </>
          )}
        </div>
      </main>
    );
  }

  /* ================= TRAINER PRODUCT ================= */

  return (
    <main className="page ai-shell">
      {/* header */}
      <header className="ai-head">
        <div className="ai-head-id">
          <div className="eyebrow">{facility.name}</div>
          <h1>{athlete.name}</h1>
          <div className="ai-head-meta">
            {athlete.sport} · {analysisPeriod}{reportRun?.asOf ? " (checkpoint)" : ""} · Latest test {props.lastTestDate ?? "—"}
          </div>
        </div>
        <div className="ai-head-side">
          <div className="ai-head-pills">
            {reviewPill}
            {evalStatus !== "pass" && (
              <span className="ai-pill" data-tone={evalStatus === "warn" ? "watch" : "alert"}>
                Safety {evalStatus === "warn" ? "caution" : "failed"}
              </span>
            )}
            {reportRun?.mode !== "live" && <span className="ai-pill" data-tone="stage">Demo data</span>}
            {fellBack && <span className="ai-pill" data-tone="watch">Offline analysis</span>}
          </div>
          <div className="ai-head-actions">
            <select value={athlete.id} onChange={(e) => router.push(`/agent?athlete=${e.target.value}`)} aria-label="Choose athlete">
              {props.athletes.map((a) => (
                <option key={a.id} value={a.id}>{a.name} — {a.team}</option>
              ))}
            </select>
            <button className="btn secondary" disabled={!!busy} onClick={() => execute({ task: "report" }, "report")}>
              {busy === "report" ? "Refreshing…" : "Refresh"}
            </button>
            <button className="btn" disabled={!report} onClick={() => setSheetOpen(true)}>Record review</button>
          </div>
        </div>
      </header>

      {error && (
        <div className="ai-alert" data-level="warn" style={{ marginBottom: 16 }}>
          <div className="ai-alert-title">Couldn&apos;t reach the analysis service</div>
          <p className="ai-alert-body">{report ? "The last saved report is still shown below." : "Please try again."}</p>
        </div>
      )}

      {/* navigation */}
      <nav className="ai-nav" role="tablist" aria-label="Views">
        {VIEWS.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => { viewRefs.current[i] = el; }}
            role="tab"
            aria-selected={view === t.key}
            tabIndex={view === t.key ? 0 : -1}
            className="ai-nav-btn"
            data-active={view === t.key}
            onClick={() => setView(t.key)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              const next = (i + (e.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length;
              setView(VIEWS[next].key);
              viewRefs.current[next]?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {busy && (
        <div className="ai-busy" aria-live="polite">
          {busy === "report" || busy === "replay"
            ? "Analyzing the athlete's data and running safety checks…"
            : "Answering from the athlete's data…"}
        </div>
      )}

      {/* ================= BRIEFING ================= */}
      {view === "briefing" && (
        <section role="tabpanel" aria-label="Briefing">
          {!report ? (
            <div className="ai-empty">
              <h2>No analysis yet</h2>
              <p>Run the analysis to see this athlete&apos;s current picture.</p>
              <button className="btn" disabled={!!busy} onClick={() => execute({ task: "report" }, "report")}>Run analysis</button>
            </div>
          ) : (
            <>
              {tiles.length > 0 && (
                <div className="stats">
                  {tiles.map((t) => (
                    <div key={t.label} className="stat-tile" style={{ borderTopColor: BUCKET_ACCENT[t.tone] }}>
                      <div className="stat-l">{t.label}</div>
                      <div className="stat-v">
                        {t.value}
                        {t.delta != null && (
                          <span className="stat-delta" data-dir={t.delta >= 0 ? "up" : "down"}>
                            {t.delta >= 0 ? "▲" : "▼"} {Math.abs(t.delta)}%
                          </span>
                        )}
                      </div>
                      <div className="stat-c">{t.context}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="ai-statusline">
                <span className="ai-status-main">{statusStatement}</span>
                {evalStatus === "pass" && <span className="ai-status-safety">✓ Safety checks passed · evidence-bound, non-medical</span>}
              </div>
              <SafetyNotice run={reportRun!} />

              <div className="ai-grid">
                <div className="ai-main">
                  <h2 className="ai-h" style={{ color: "var(--watch)" }}>Needs attention</h2>
                  {priorities.length === 0 ? (
                    <p className="quiet-line">Nothing is flagged right now — the signals below are steady.</p>
                  ) : (
                    priorities.map((c) => <FindingBlock key={c.claimId} claim={c} bucket={bucketOf(c, report.conflictingSignals.includes(c.claimId))} />)
                  )}
                  {secondary.length > 0 && (
                    <>
                      <h2 className="ai-h" style={{ color: "var(--ink-dim)" }}>Also tracking</h2>
                      {secondary.map((c) => <FindingBlock key={c.claimId} claim={c} bucket={bucketOf(c, report.conflictingSignals.includes(c.claimId))} quiet />)}
                    </>
                  )}
                  {grouped.stable.length > 0 && (
                    <>
                      <h2 className="ai-h" style={{ color: "var(--ok)" }}>Steady or improving</h2>
                      {grouped.stable.map((c) => <FindingBlock key={c.claimId} claim={c} bucket="stable" quiet />)}
                    </>
                  )}
                  <h2 className="ai-h" style={{ color: "var(--ink-mute)" }}>Data notes & context</h2>
                  {grouped.context.length === 0 && report.dataQualityNotes.length === 0 ? (
                    <p className="quiet-line">No data limitations flagged for this window.</p>
                  ) : (
                    <>
                      {grouped.context.map((c) => <FindingBlock key={c.claimId} claim={c} bucket="context" quiet />)}
                      <p className="quiet-line">{report.dataQualityNotes.join(" · ")}</p>
                    </>
                  )}
                </div>

                <aside className="ai-rail">
                  <div className="rail-card">
                    <h3>Summary</h3>
                    <p className="rail-summary">{latestReview?.revisedExecutiveSummary ?? report.executiveSummary}</p>
                    {latestReview?.revisedExecutiveSummary && (
                      <p className="rail-note">Your revised interpretation — the original is preserved in Review.</p>
                    )}
                  </div>
                  <div className="rail-card">
                    <h3>Review next</h3>
                    <ul className="rail-list">
                      {report.recommendedReviewAreas.map((q, i) => <li key={i}>{q}</li>)}
                      {report.coachQuestions.slice(0, 2).map((q, i) => <li key={`q${i}`}>{q}</li>)}
                    </ul>
                    <button className="btn rail-btn" onClick={() => setSheetOpen(true)}>Record review</button>
                    <p className="rail-note">
                      {latestReview ? `Last decision: ${REVIEW_LABEL[latestReview.action]} · ${shortStamp(latestReview.timestamp)}` : "This report is awaiting your decision."}
                    </p>
                  </div>
                </aside>
              </div>
            </>
          )}
        </section>
      )}

      {/* ================= ASK ================= */}
      {view === "ask" && (
        <section role="tabpanel" aria-label="Ask the data">
          <p className="ai-lede">Seven focused questions — every answer cites the records it used.</p>
          <div className="q-grid">
            {QUESTION_KEYS.map((k) => (
              <button key={k} className="q-card" data-active={answerRun?.answer?.questionKey === k} disabled={!!busy}
                onClick={() => execute({ task: "question", questionKey: k }, k)}>
                {busy === k ? "Answering…" : QUESTION_LABELS[k as QuestionKey]}
              </button>
            ))}
          </div>

          {answerRun?.answer ? (
            <article className="ans">
              <div className="eyebrow">Answer</div>
              <h2 className="ans-q">{answerRun.answer.question}</h2>
              <p className="ans-summary">{answerRun.answer.summary}</p>
              <SafetyNotice run={answerRun} />
              <div style={{ marginTop: 14 }}>
                {answerRun.answer.claims.map((c) => <FindingBlock key={c.claimId} claim={c} bucket={bucketOf(c, false)} quiet />)}
              </div>
              <p className="fb-ctx" style={{ marginTop: 8 }}>Answered {shortTime(answerRun.createdAt)}</p>
            </article>
          ) : (
            <p className="quiet-line" style={{ marginTop: 20 }}>Pick a question above — the answer will appear here.</p>
          )}

          {answerRuns.filter((r) => r.runId !== answerRun?.runId).length > 0 && (
            <div style={{ marginTop: 28 }}>
              <h2 className="ai-h" style={{ color: "var(--ink-mute)" }}>Earlier answers</h2>
              <div className="prev-answers">
                {answerRuns.slice(-6).reverse().filter((r) => r.runId !== answerRun?.runId).map((r) => (
                  <button key={r.runId} className="prev-answer" onClick={() => setAnswerId(r.runId)}>
                    <span>{r.answer!.question}</span>
                    <span className="fb-ctx">{shortTime(r.createdAt)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ================= TIMELINE ================= */}
      {view === "timeline" && (
        <section role="tabpanel" aria-label="Timeline">
          <p className="ai-lede">
            Rewind the analysis to an earlier date — it only sees data available then — and compare any two reports.
          </p>
          <div className="tl-checkpoints">
            {props.checkpoints.map((c) => (
              <button key={c.date} className="tl-chip" data-active={reportRun?.asOf === c.date} disabled={!!busy}
                onClick={() => execute({ task: "report", asOf: c.date }, "replay")}>
                <span className="tl-chip-date">{c.date}</span>
                <span className="tl-chip-label">{c.label.length > 32 ? c.label.slice(0, 32) + "…" : c.label}</span>
              </button>
            ))}
            <button className="tl-chip" data-active={!reportRun?.asOf} disabled={!!busy}
              onClick={() => execute({ task: "report" }, "replay")}>
              <span className="tl-chip-date">today</span>
              <span className="tl-chip-label">Current (full data)</span>
            </button>
          </div>
          {props.checkpoints.length === 0 && (
            <p className="quiet-line">No milestones recorded for this athlete — only the current view is available.</p>
          )}
          {reportRun?.asOf && (
            <div className="ai-alert" data-level="info">
              <p className="ai-alert-body" style={{ margin: 0 }}>
                Viewing <strong>{reportRun.asOf}</strong> — built only from data available on or before that date.
                The whole workspace follows this point in time until you return to “Current (full data)”.
              </p>
            </div>
          )}

          <h2 className="ai-h" style={{ marginTop: 26 }}>What changed</h2>
          {reportRuns.length < 2 ? (
            <p className="quiet-line">
              Only one report exists so far — rewind to a checkpoint above (or refresh the analysis) and the comparison will appear here.
            </p>
          ) : (
            <>
              <div className="cmp-row">
                <span className="fb-ctx">Compare the report shown now with:</span>
                {reportRuns.filter((r) => r.runId !== reportRun?.runId).slice(-4).map((r) => (
                  <button key={r.runId} className="cmp-pill" data-active={compareAgainst === r.runId}
                    onClick={() => setCompareAgainst(r.runId)}>
                    {r.asOf ? `Checkpoint ${r.asOf}` : `Full data · ${shortTime(r.createdAt)}`}
                  </button>
                ))}
              </div>
              {diff && (
                <div style={{ marginTop: 14 }}>
                  {diff.added.length + diff.removed.length + diff.changed.length === 0 ? (
                    <p className="quiet-line">No substantive differences between these two reports.</p>
                  ) : (
                    [
                      {
                        title: "Meaningful changes",
                        tone: "var(--watch)",
                        items: diff.changed.filter((ch) => ch.textChanged || ch.confidenceChanged).map((ch) => ({
                          key: ch.identityKey,
                          head: `${claimHeadline(ch.after)}${ch.confidenceChanged ? ` · confidence ${ch.before.confidence} → ${ch.after.confidence}` : ""}`,
                          body: `Was: ${ch.before.text}\nNow: ${ch.after.text}`,
                        })),
                      },
                      { title: "New findings", tone: "var(--ok)", items: diff.added.map((c) => ({ key: c.claimId, head: claimHeadline(c), body: c.text })) },
                      { title: "No longer present", tone: "var(--ink-mute)", items: diff.removed.map((c) => ({ key: c.claimId, head: claimHeadline(c), body: c.text })) },
                      {
                        title: "Updated by new data only",
                        tone: "var(--left)",
                        items: diff.changed.filter((ch) => !ch.textChanged && !ch.confidenceChanged && ch.newEvidence.length > 0).map((ch) => ({
                          key: ch.identityKey,
                          head: claimHeadline(ch.after),
                          body: `Same conclusion — the evidence set gained ${ch.newEvidence.length} new record${ch.newEvidence.length > 1 ? "s" : ""}.`,
                        })),
                      },
                    ].map((sec) =>
                      sec.items.length === 0 ? null : (
                        <div key={sec.title} style={{ marginBottom: 14 }}>
                          <h3 className="ai-h" style={{ color: sec.tone }}>{sec.title}</h3>
                          {sec.items.map((it) => (
                            <div key={it.key} className="fb fb--quiet" style={{ borderLeftColor: sec.tone }}>
                              <div className="fb-title" style={{ fontSize: 14.5 }}>{it.head}</div>
                              <p className="fb-text" style={{ whiteSpace: "pre-line" }}>{it.body}</p>
                            </div>
                          ))}
                        </div>
                      )
                    )
                  )}
                </div>
              )}
            </>
          )}

          <h2 className="ai-h" style={{ marginTop: 26, color: "var(--ink-dim)" }}>Your decisions</h2>
          {athleteReviews.length === 0 ? (
            <p className="quiet-line">No review decisions recorded for this athlete yet.</p>
          ) : (
            <div className="decision-list">
              {athleteReviews.slice(0, 8).map((rv) => (
                <div key={rv.reviewId} className="decision">
                  <span className="decision-dot" style={{ background: `var(--${REVIEW_TONE[rv.action] === "stage" ? "stage" : REVIEW_TONE[rv.action]})` }} aria-hidden />
                  <div style={{ minWidth: 0 }}>
                    <div className="decision-head">
                      {REVIEW_LABEL[rv.action]} <span className="fb-ctx">{shortStamp(rv.timestamp)}</span>
                    </div>
                    {(rv.reason || rv.revisedExecutiveSummary) && (
                      <div className="decision-body">{rv.reason ?? "Summary revised (original preserved)."}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ================= REVIEW SHEET ================= */}
      {sheetOpen && report && (
        <>
          <div className="sheet-backdrop" onClick={() => setSheetOpen(false)} aria-hidden />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Record review" ref={sheetRef}>
            <div className="sheet-head">
              <div>
                <div className="eyebrow">Your decision</div>
                <h2 style={{ fontSize: 18 }}>Review this report</h2>
              </div>
              <button className="linklike" onClick={() => setSheetOpen(false)}>Close</button>
            </div>
            <p className="fb-ctx" style={{ marginBottom: 10 }}>
              Generated {shortStamp(report.generatedAt)}{reportRun?.asOf ? ` · checkpoint ${reportRun.asOf}` : ""} · current state:{" "}
              <strong style={{ color: "var(--ink-dim)" }}>{latestReview ? REVIEW_LABEL[latestReview.action] : "awaiting review"}</strong>
            </p>
            <div className="sheet-summary">{report.executiveSummary}</div>
            {latestReview?.revisedExecutiveSummary && (
              <div className="sheet-revised">
                <strong style={{ color: "var(--stage)" }}>Your current revision:</strong> {latestReview.revisedExecutiveSummary}
                <div className="fb-ctx" style={{ marginTop: 4 }}>The original above is preserved unchanged.</div>
              </div>
            )}

            {!pendingAction ? (
              <div className="sheet-actions">
                {REVIEW_ACTIONS.map(({ action, label, consequence }) => (
                  <button key={action} className="sheet-action" data-action={action}
                    onClick={() => { setPendingAction(action); if (action === "edit") setEditText(latestReview?.revisedExecutiveSummary ?? report.executiveSummary); }}>
                    <span className="sheet-action-label">{label}</span>
                    <span className="sheet-action-desc">{consequence}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="sheet-confirm">
                <div className="fb-ctx" style={{ marginBottom: 6 }}>
                  {REVIEW_ACTIONS.find((a) => a.action === pendingAction)!.consequence}
                </div>
                {pendingAction === "edit" && (
                  <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={5} aria-label="Revised interpretation" />
                )}
                <label style={{ display: "block", margin: "10px 0 4px", fontSize: 13, color: pendingAction === "approve" ? "var(--ink-mute)" : "var(--ink-dim)", fontWeight: pendingAction === "approve" ? 400 : 600 }}>
                  {pendingAction === "approve" ? "Optional note" : "Note (recommended — kept with your decision)"}
                </label>
                <input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="e.g. matches what I saw on the floor this week" />
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    className="btn"
                    style={pendingAction === "approve" ? { background: "var(--ok)" } : pendingAction === "reject" ? { background: "var(--alert)" } : undefined}
                    disabled={pendingAction === "edit" && !editText.trim()}
                    onClick={() => saveReview(pendingAction)}
                  >
                    Confirm — {REVIEW_ACTIONS.find((a) => a.action === pendingAction)!.label}
                  </button>
                  <button className="btn secondary" onClick={() => setPendingAction(null)}>Back</button>
                </div>
              </div>
            )}

            <div className="sheet-history">
              <h3 className="ai-h" style={{ color: "var(--ink-mute)" }}>History for this report</h3>
              {reportReviews.length === 0 ? (
                <p className="quiet-line">No decisions recorded yet.</p>
              ) : (
                reportReviews.slice().reverse().map((rv) => (
                  <div key={rv.reviewId} className="decision">
                    <span className="decision-dot" style={{ background: `var(--${REVIEW_TONE[rv.action] === "stage" ? "stage" : REVIEW_TONE[rv.action]})` }} aria-hidden />
                    <div style={{ minWidth: 0 }}>
                      <div className="decision-head">{REVIEW_LABEL[rv.action]} <span className="fb-ctx">{shortStamp(rv.timestamp)}</span></div>
                      {(rv.reason || rv.revisedExecutiveSummary) && (
                        <div className="decision-body">{rv.reason ?? rv.revisedExecutiveSummary}</div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {/* footer */}
      <footer className="ai-foot">
        <span>
          Synthetic demo data. This system explains evidence; it does not diagnose, predict injury, or make
          clearance decisions — those remain with the athlete&apos;s qualified team, and every report requires human review.
        </span>
        <button className="devlink" onClick={() => setDevMode(true)}>Developer & audit view</button>
      </footer>
    </main>
  );
}
