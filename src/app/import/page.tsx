import { currentFacility } from "@/lib/facility";
import { listImportBatches, listDataSources, listAthletes } from "@/lib/db/dal";
import { METRICS } from "@/lib/config/metrics";
import ImportClient from "./ImportClient";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const facility = await currentFacility();
  const batches = listImportBatches(facility.id);
  const sources = listDataSources(facility.id);
  const athletes = listAthletes(facility.id).map((a) => ({ id: a.id, name: a.display_name }));
  const manualMetrics = Object.values(METRICS)
    .filter((m) => m.status === "implemented" && m.testType !== "derived")
    .map((m) => ({ key: m.key, label: `${m.shortLabel} (${m.unit || "ratio"})`, testType: m.testType, sided: m.sided }));

  return (
    <main className="page">
      <div className="page-head">
        <div className="eyebrow">{facility.name} · Data pipeline</div>
        <h1>Imports &amp; Manual Entry</h1>
        <div className="sub">
          Every path runs the same pipeline: inspect → map to canonical → validate → import raw → compute
          metrics → generate findings. Imports are scoped to this facility; rows referencing other
          facilities&apos; athletes are rejected at validation.
        </div>
      </div>

      <ImportClient athletes={athletes} manualMetrics={manualMetrics} />

      <div className="panel">
        <h2>Data sources &amp; adapters</h2>
        <p className="panel-sub">
          Vendor API adapters are interface-defined only in V1 — no credentials are stored and no live calls
          are made. See the roadmap for activation requirements.
        </p>
        <table className="data">
          <thead>
            <tr><th>Source</th><th>Adapter key</th><th>Status</th></tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td>{s.label}</td>
                <td style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{s.adapter_key}</td>
                <td>
                  {s.kind === "operational" ? (
                    <span className="chip" data-tone="ok">operational</span>
                  ) : (
                    <span className="chip" data-tone="provisional">interface-defined stub</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Import batch history</h2>
        <table className="data">
          <thead>
            <tr><th>Created</th><th>Source</th><th>File / label</th><th className="num">Rows</th><th>Status</th><th>Result</th></tr>
          </thead>
          <tbody>
            {batches.map((b) => {
              const summary = b.summary_json ? (JSON.parse(b.summary_json) as { sessions?: number; trials?: number; metrics?: number; findings?: number }) : null;
              const error = b.error_json ? (JSON.parse(b.error_json) as { errors?: string[]; issues?: string[]; message?: string }) : null;
              return (
                <tr key={b.id}>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{b.created_at.slice(0, 16).replace("T", " ")}</td>
                  <td>{b.source_label}</td>
                  <td style={{ fontSize: 12.5, color: "var(--ink-dim)" }}>{b.filename ?? "—"}</td>
                  <td className="num">{b.row_count ?? "—"}</td>
                  <td>
                    <span className="chip" data-tone={b.status === "complete" ? "ok" : b.status === "failed" ? "alert" : undefined}>
                      {b.status}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: "var(--ink-dim)" }}>
                    {summary
                      ? `${summary.sessions} sessions · ${summary.trials} trials · ${summary.metrics} metrics · ${summary.findings} findings`
                      : error
                        ? (error.message ?? error.errors?.[0] ?? error.issues?.[0] ?? "failed")
                        : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
