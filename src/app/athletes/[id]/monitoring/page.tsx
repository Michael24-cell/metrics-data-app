import { notFound } from "next/navigation";
import { currentFacility } from "@/lib/facility";
import { getAthlete } from "@/lib/db/dal";
import { effectivePolicy } from "@/lib/services/monitoringPolicy";
import { listMonitoringResults } from "@/lib/services/monitoringEngine";
import { reliabilityForMetric } from "@/lib/services/reliability";
import { METRICS } from "@/lib/config/metrics";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, { label: string; tone?: string; icon: string }> = {
  within_expected_range: { label: "Within expected range", tone: "ok", icon: "●" },
  review_suggested: { label: "Review suggested", tone: "watch", icon: "▲" },
  repeated_low_signal: { label: "Repeated low signal", tone: "alert", icon: "■" },
  collecting_baseline: { label: "Collecting baseline", icon: "◔" },
  insufficient_reliable_data: { label: "Insufficient reliable data", icon: "◇" },
};

/** Athlete monitoring view: policy, per-metric classification, reliability, history. */
export default async function AthleteMonitoringPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const facility = await currentFacility();
  const athlete = getAthlete(facility.id, id);
  if (!athlete) notFound();

  const eff = effectivePolicy(facility.id, id);
  const metrics = eff.policy.metricKeys
    .filter((mk) => METRICS[mk])
    .map((mk) => {
      const rows = listMonitoringResults(facility.id, id, mk, eff.fingerprint);
      const rel = reliabilityForMetric(facility.id, id, mk);
      return { def: METRICS[mk], rows, latest: rows[rows.length - 1] ?? null, rel };
    });

  return (
    <main className="page">
      <div className="page-head" style={{ display: "flex", alignItems: "flex-end", gap: 18, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <div className="eyebrow">{facility.name} · Monitoring</div>
          <h1>{athlete.display_name}</h1>
          <div className="sub">
            Effective policy: baseline {eff.policy.baselineSessions} · rolling {eff.policy.rollingWindow} · noise gate{" "}
            {eff.policy.noiseGate === "none" ? "none configured (range only)" : eff.policy.noiseGate.toUpperCase()} ·{" "}
            {eff.layers.length ? eff.layers.map((l) => `${l.scope} v${l.version}`).join(" → ") : "product default"}
          </div>
        </div>
        <div className="no-print" style={{ display: "flex", gap: 8 }}>
          <a className="btn secondary" href={`/athletes/${id}`}>Analysis</a>
          <a className="btn secondary" href={`/settings/monitoring?athlete=${id}`}>Configure</a>
          <a className="btn" href={`/agent?athlete=${id}&q=${encodeURIComponent("What is this athlete's monitoring status?")}`}>Ask the agent</a>
        </div>
      </div>

      {metrics.map(({ def, rows, latest, rel }) => {
        const s = latest ? STATE_LABEL[latest.monitoring_state] : null;
        const p = def.precision;
        const diff = latest?.reference_mean != null ? latest.current_value - latest.reference_mean : null;
        const pct = latest?.reference_mean ? ((latest.current_value - latest.reference_mean) / Math.abs(latest.reference_mean)) * 100 : null;
        return (
          <div className="panel" key={def.key}>
            <h2>
              {def.label}{" "}
              {s && <span className="chip" data-tone={s.tone}>{s.icon} {s.label}</span>}
              {rel.reliabilityWarning && <span className="chip" data-tone="watch" style={{ marginLeft: 6 }}>reliability warning</span>}
            </h2>
            {!latest ? (
              <div className="callout">No monitoring results for this metric yet.</div>
            ) : latest.monitoring_state === "collecting_baseline" ? (
              <p className="panel-sub">
                Collecting baseline: {latest.reference_count + 1} of {eff.policy.baselineSessions} eligible sessions recorded.
                Values are stored and provisional summaries exist, but no automated signals, status colors, or
                training suggestions are produced during baseline.
              </p>
            ) : (
              <>
                <div className="statrow" style={{ marginBottom: 10 }}>
                  <div className="stat"><div className="k">Latest ({latest.session_date})</div><div className="v">{latest.current_value.toFixed(p)}<small>{def.unit}</small></div></div>
                  <div className="stat"><div className="k">Rolling mean (prev {latest.reference_count})</div><div className="v">{latest.reference_mean!.toFixed(p)}<small>{def.unit}</small></div></div>
                  <div className="stat"><div className="k">Expected range</div><div className="v" style={{ fontSize: 16 }}>{latest.band_low!.toFixed(p)}–{latest.band_high!.toFixed(p)}<small>{def.unit}</small></div></div>
                  <div className="stat"><div className="k">Difference</div><div className="v">{diff! > 0 ? "+" : ""}{diff!.toFixed(p)}<small>{def.unit}</small></div><div className="d">{pct != null ? `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%` : ""}</div></div>
                </div>
                <p className="panel-sub" style={{ marginBottom: 6 }}>
                  {latest.noise_state === "reliability_unavailable" && eff.policy.noiseGate === "none"
                    ? "No measurement-noise gate is configured — range position is shown without claiming the change exceeds measurement noise."
                    : latest.noise_state === "exceeds_threshold"
                      ? `The change exceeds the configured ${eff.policy.noiseGate.toUpperCase()} threshold.`
                      : latest.noise_state === "within_noise"
                        ? `The change is within the configured ${eff.policy.noiseGate.toUpperCase()} threshold (expected measurement variability).`
                        : "Reliability statistics are unavailable or limited for this metric."}
                </p>
              </>
            )}

            <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginBottom: 8 }}>
              Reliability ({rel.availability.replace(/_/g, " ")}): CV latest{" "}
              {rel.latestSessionCv?.cvPct != null ? `${rel.latestSessionCv.cvPct.toFixed(1)}%` : "—"} · mean CV{" "}
              {rel.meanSessionCvPct != null ? `${rel.meanSessionCvPct.toFixed(1)}%` : "—"} · TE{" "}
              {rel.te.te != null ? `${rel.te.te.toFixed(2)} ${def.unit}` : "—"} · SWC{" "}
              {rel.swc.value != null ? `${rel.swc.value.toFixed(2)} ${def.unit}` : "not configured"} · MDC{" "}
              {rel.mdc.mdc != null ? `${rel.mdc.mdc.toFixed(2)} ${def.unit} (${rel.mdc.confidence}%)` : "—"}
            </div>

            {rows.length > 1 && (
              <details>
                <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--ink-dim)" }}>
                  History ({rows.length} sessions, policy {rows[0].policy_fingerprint.slice(0, 28)}…)
                </summary>
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                  <table className="data">
                    <thead><tr><th>Date</th><th className="num">Value</th><th className="num">Range</th><th>State</th></tr></thead>
                    <tbody>
                      {rows.slice(-15).reverse().map((r) => (
                        <tr key={r.id}>
                          <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{r.session_date}</td>
                          <td className="num">{r.current_value.toFixed(p)}</td>
                          <td className="num">{r.band_low != null ? `${r.band_low.toFixed(p)}–${r.band_high!.toFixed(p)}` : "—"}</td>
                          <td><span className="chip" data-tone={STATE_LABEL[r.monitoring_state]?.tone}>{STATE_LABEL[r.monitoring_state]?.label ?? r.monitoring_state}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>
        );
      })}
      {metrics.length === 0 && <div className="callout">No monitored metrics selected — configure monitoring for this athlete.</div>}
    </main>
  );
}
