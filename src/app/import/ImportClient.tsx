"use client";

/**
 * Import workbench: generic CSV mapper (with dry-run inspect/validate step)
 * and manual entry. Both call the same pipeline API.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

interface DryRun {
  inspect: { ok: boolean; columns?: string[]; rowCount?: number; issues: string[] };
  validation: { ok: boolean; errors: string[]; warnings: string[] } | null;
  sessionCount?: number;
}

interface RunResult {
  status: string;
  sessionIds?: string[];
  metricCount?: number;
  findingsGenerated?: number;
  validation?: { errors: string[]; warnings: string[] };
  error?: string;
}

const CSV_TEMPLATE = `athlete_id,test_type,session_date,metric_type,side,value
<athlete-id>,cmj,2026-07-09,cmj_jump_height,bilateral,34.2
<athlete-id>,imtp,2026-07-09,imtp_peak_force,left,2140
<athlete-id>,imtp,2026-07-09,imtp_peak_force,right,2010`;

export default function ImportClient({
  athletes,
  manualMetrics,
}: {
  athletes: { id: string; name: string }[];
  manualMetrics: { key: string; label: string; testType: string; sided: boolean }[];
}) {
  const router = useRouter();

  /* ---- CSV state ---- */
  const [csv, setCsv] = useState("");
  const [dry, setDry] = useState<DryRun | null>(null);
  const [csvResult, setCsvResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);

  /* ---- manual entry state ---- */
  const [mAthlete, setMAthlete] = useState(athletes[0]?.id ?? "");
  const [mMetric, setMMetric] = useState(manualMetrics[0]?.key ?? "");
  const [mSide, setMSide] = useState<"bilateral" | "left" | "right">("bilateral");
  const [mDate, setMDate] = useState("2026-07-09");
  const [mValue, setMValue] = useState("");
  const [mNotes, setMNotes] = useState("");
  const [mResult, setMResult] = useState<RunResult | null>(null);

  const post = async (body: unknown): Promise<RunResult & DryRun> => {
    const res = await fetch("/api/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  const csvInput = { filename: "pasted.csv", content: csv };
  const metricDef = manualMetrics.find((m) => m.key === mMetric);

  return (
    <div className="grid2">
      <div className="panel" style={{ marginTop: 0 }}>
        <h2>Generic CSV mapper</h2>
        <p className="panel-sub">
          Long-format CSV: one metric value per row. Inspect &amp; validate before anything is written.
        </p>
        <div className="field">
          <label htmlFor="csvbox">CSV content</label>
          <textarea
            id="csvbox"
            rows={8}
            value={csv}
            onChange={(e) => { setCsv(e.target.value); setDry(null); setCsvResult(null); }}
            placeholder={CSV_TEMPLATE}
          />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button
            className="btn secondary"
            disabled={!csv.trim() || busy}
            onClick={async () => {
              setBusy(true);
              setDry(await post({ adapter: "csv_generic", input: csvInput, dryRun: true }));
              setBusy(false);
            }}
          >
            1 · Inspect &amp; validate
          </button>
          <button
            className="btn"
            disabled={!dry?.validation?.ok || busy}
            onClick={async () => {
              setBusy(true);
              const r = await post({ adapter: "csv_generic", input: csvInput });
              setCsvResult(r);
              setBusy(false);
              router.refresh();
            }}
          >
            2 · Run import
          </button>
        </div>
        {dry && (
          <div className="callout" data-tone={dry.validation?.ok ? "ok" : "error"} style={{ marginTop: 10 }}>
            {dry.inspect.ok
              ? `Detected ${dry.inspect.rowCount} rows, columns: ${dry.inspect.columns?.join(", ")}. `
              : `Inspection failed: ${dry.inspect.issues.join(" ")} `}
            {dry.validation &&
              (dry.validation.ok
                ? `Validation passed — ${dry.sessionCount} session(s) ready to import.`
                : `Validation errors: ${dry.validation.errors.join(" ")}`)}
            {dry.validation?.warnings?.length ? ` Warnings: ${dry.validation.warnings.join(" ")}` : ""}
          </div>
        )}
        {csvResult && (
          <div className="callout" data-tone={csvResult.status === "complete" ? "ok" : "error"} style={{ marginTop: 10 }}>
            {csvResult.status === "complete"
              ? `Imported: ${csvResult.sessionIds?.length} session(s), ${csvResult.metricCount} derived metrics, ${csvResult.findingsGenerated} findings regenerated.`
              : `Import failed: ${csvResult.validation?.errors?.join(" ") ?? csvResult.error}`}
          </div>
        )}
        <details style={{ marginTop: 10, fontSize: 12, color: "var(--ink-dim)" }}>
          <summary style={{ cursor: "pointer" }}>Column reference &amp; athlete IDs</summary>
          <pre style={{ fontSize: 11, background: "var(--bg2)", padding: 10, borderRadius: 6, overflowX: "auto" }}>{CSV_TEMPLATE}</pre>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {athletes.map((a) => (
              <div key={a.id}>{a.id} — {a.name}</div>
            ))}
          </div>
        </details>
      </div>

      <div className="panel" style={{ marginTop: 0 }}>
        <h2>Manual entry</h2>
        <p className="panel-sub">
          For sessions without device export. Values are stored with source “manual” and quality-checked
          against the metric&apos;s plausible range.
        </p>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="m-athlete">Athlete</label>
            <select id="m-athlete" value={mAthlete} onChange={(e) => setMAthlete(e.target.value)}>
              {athletes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="m-metric">Metric</label>
            <select id="m-metric" value={mMetric} onChange={(e) => setMMetric(e.target.value)}>
              {manualMetrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="m-side">Side</label>
            <select id="m-side" value={mSide} onChange={(e) => setMSide(e.target.value as typeof mSide)} disabled={!metricDef?.sided}>
              <option value="bilateral">bilateral</option>
              <option value="left">left</option>
              <option value="right">right</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="m-date">Session date</label>
            <input id="m-date" type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="m-value">Value</label>
            <input id="m-value" type="number" step="any" value={mValue} onChange={(e) => setMValue(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="m-notes">Notes</label>
            <input id="m-notes" value={mNotes} onChange={(e) => setMNotes(e.target.value)} placeholder="optional" />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button
            className="btn"
            disabled={!mValue || busy}
            onClick={async () => {
              setBusy(true);
              const r = await post({
                adapter: "manual_entry",
                input: {
                  athleteId: mAthlete,
                  testType: metricDef?.testType ?? "cmj",
                  sessionDate: mDate,
                  notes: mNotes || undefined,
                  metrics: [{ metricType: mMetric, side: mSide, value: Number(mValue) }],
                },
              });
              setMResult(r);
              setBusy(false);
              router.refresh();
            }}
          >
            Save session
          </button>
        </div>
        {mResult && (
          <div className="callout" data-tone={mResult.status === "complete" ? "ok" : "error"} style={{ marginTop: 10 }}>
            {mResult.status === "complete"
              ? `Saved — session created, findings regenerated (${mResult.findingsGenerated}).`
              : `Failed: ${mResult.validation?.errors?.join(" ") ?? mResult.error}`}
          </div>
        )}
      </div>
    </div>
  );
}
